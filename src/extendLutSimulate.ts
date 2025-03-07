import { AddressLookupTableProgram, ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js"
import {
    DEVNET_PROGRAM_ID,
    jsonInfo2PoolKeys,
    Liquidity,
    MAINNET_PROGRAM_ID,
    MARKET_STATE_LAYOUT_V3, LiquidityPoolKeys,
    Token, TokenAmount,
    TOKEN_PROGRAM_ID,
    buildSimpleTransaction,
    TxVersion,
} from "@raydium-io/raydium-sdk"
import { getAssociatedTokenAddress, getAssociatedTokenAddressSync, getMint, NATIVE_MINT, unpackMint } from "@solana/spl-token";
import bs58 from "bs58"
import BN from "bn.js"

import { mainMenuWaiting, outputBalance, readBundlerWallets, readJson, readLUTAddressFromFile, readWallets, retrieveEnvVariable, saveDataToFile, sleep } from "./utils"
import {
    getTokenAccountBalance,
    assert,
    getWalletTokenAccount,
} from "./get_balance";
import { build_create_pool_instructions } from "./build_a_sendtxn";
import {
    connection,
    addLookupTableInfo, cluster,
    lookupTableCache,
    delay_pool_open_time, DEFAULT_TOKEN
} from "../config";
import {
    quote_Mint_amount,
    input_baseMint_tokens_percentage,
    swapSolAmount,
    bundlerWalletName,
    batchSize
} from "../settings"

import { createAndSendV0Tx } from "../layout/createLutAta";

const programId = cluster == "devnet" ? DEVNET_PROGRAM_ID : MAINNET_PROGRAM_ID

export async function extendLutSimulate() {
    const wallets = readBundlerWallets(bundlerWalletName)
    const data = readJson()
    const lutAddress = readLUTAddressFromFile()

    const walletKPs = wallets.map((wallet: string) => Keypair.fromSecretKey(bs58.decode(wallet)));
    const lookupTableAddress = new PublicKey(lutAddress!);
    const LP_wallet_keypair = Keypair.fromSecretKey(new Uint8Array(bs58.decode(data.mainKp!)));

    console.log("LP Wallet Address: ", LP_wallet_keypair.publicKey.toString());

    let params: any = {
        mint: data.mint ? new PublicKey(data.mint) : null,
        marketId: data.marketId ? new PublicKey(data.marketId) : null,
        poolId: data.poolId ? new PublicKey(data.poolId) : null,
        mainKp: data.mainKp,
        poolKeys: null,
        removed: data.removed
    }

    // ------- get pool keys
    console.log("------------- get pool keys for pool creation---------")

    const tokenAccountRawInfos_LP = await getWalletTokenAccount(
        connection,
        LP_wallet_keypair.publicKey
    )

    if (!params.marketId) {
        console.log("Market Id is not set.");
        mainMenuWaiting();
    } else {
        const marketBufferInfo = await connection.getAccountInfo(params.marketId);
        // console.log("🚀 ~ txCreateNewPoolAndBundleBuy ~ marketBufferInfo:", marketBufferInfo)
        if (!marketBufferInfo) return;
        const {
            baseMint,
            quoteMint,
            baseLotSize,
            quoteLotSize,
            baseVault: marketBaseVault,
            quoteVault: marketQuoteVault,
            bids: marketBids,
            asks: marketAsks,
            eventQueue: marketEventQueue
        } = MARKET_STATE_LAYOUT_V3.decode(marketBufferInfo.data);
        // console.log("Base mint: ", baseMint.toString());
        // console.log("Quote mint: ", quoteMint.toString());

        const accountInfo_base = await connection.getAccountInfo(baseMint);
        // console.log("🚀 ~ txCreateNewPoolAndBundleBuy ~ accountInfo_base:", accountInfo_base)
        if (!accountInfo_base) return;
        const baseTokenProgramId = accountInfo_base.owner;
        const baseDecimals = unpackMint(
            baseMint,
            accountInfo_base,
            baseTokenProgramId
        ).decimals;
        // console.log("Base Decimals: ", baseDecimals);

        const accountInfo_quote = await connection.getAccountInfo(quoteMint);
        // console.log("🚀 ~ txCreateNewPoolAndBundleBuy ~ accountInfo_quote:", accountInfo_quote)
        if (!accountInfo_quote) return;
        const quoteTokenProgramId = accountInfo_quote.owner;
        const quoteDecimals = unpackMint(
            quoteMint,
            accountInfo_quote,
            quoteTokenProgramId
        ).decimals;
        // console.log("Quote Decimals: ", quoteDecimals);

        const associatedPoolKeys = await Liquidity.getAssociatedPoolKeys({
            version: 4,
            marketVersion: 3,
            baseMint,
            quoteMint,
            baseDecimals,
            quoteDecimals,
            marketId: params.marketId,
            programId: programId.AmmV4,
            marketProgramId: programId.OPENBOOK_MARKET,
        });
        // const { id: ammId, lpMint } = associatedPoolKeys;
        params.poolId = associatedPoolKeys.id
        params.poolKeys = associatedPoolKeys

        saveDataToFile(params)

        // console.log("AMM ID: ", ammId.toString());
        // console.log("lpMint: ", lpMint.toString());

        // --------------------------------------------
        let quote_amount = quote_Mint_amount * 10 ** quoteDecimals;
        // -------------------------------------- Get balance
        let base_balance: number;
        let quote_balance: number;

        if (baseMint.toBase58() == "So11111111111111111111111111111111111111112") {
            console.log("second")
            base_balance = await connection.getBalance(LP_wallet_keypair.publicKey);
            if (!base_balance) return;
            console.log("SOL Balance:", base_balance);
        } else {
            const baseAta = await getAssociatedTokenAddressSync(baseMint, LP_wallet_keypair.publicKey)
            const temp = (await connection.getTokenAccountBalance(baseAta)).value.amount
            base_balance = Number(temp) || 0;
        }

        if (quoteMint.toString() == "So11111111111111111111111111111111111111112") {
            quote_balance = await connection.getBalance(LP_wallet_keypair.publicKey);
            if (!quote_balance) return;
            // console.log("SOL Balance:", quote_balance);
            assert(
                quote_amount <= quote_balance,
                "Sol LP input is greater than current balance"
            );
        } else {
            const temp = await getTokenAccountBalance(
                connection,
                LP_wallet_keypair.publicKey.toString(),
                quoteMint.toString()
            );
            quote_balance = temp || 0;
        }

        let base_amount_input = Math.ceil(base_balance * input_baseMint_tokens_percentage);
        console.log("Input Base: ", base_amount_input);

        // step2: init new pool (inject money into the created pool)
        const lp_ix = await build_create_pool_instructions(
            programId,
            params.marketId,
            LP_wallet_keypair,
            tokenAccountRawInfos_LP,
            baseMint,
            baseDecimals,
            quoteMint,
            quoteDecimals,
            delay_pool_open_time,
            base_amount_input,
            quote_amount,
            lookupTableCache
        );

        const createPoolRecentBlockhash = (await connection.getLatestBlockhash().catch(async () => {
            // await sleep(2_000)
            return await connection.getLatestBlockhash().catch(getLatestBlockhashError => {
                console.log({ getLatestBlockhashError })
                return null
            })
        }))?.blockhash;
        if (!createPoolRecentBlockhash) return { Err: "Failed to prepare transaction" }

        const createPoolTransaction = (await buildSimpleTransaction({
            connection,
            makeTxVersion: TxVersion.V0,
            payer: LP_wallet_keypair.publicKey,
            innerTransactions: lp_ix,
            addLookupTableInfo: addLookupTableInfo,
            recentBlockhash: createPoolRecentBlockhash
        })) as VersionedTransaction[];
        createPoolTransaction[0].sign([LP_wallet_keypair]);

        console.log((await connection.simulateTransaction(createPoolTransaction[0], undefined)));
        console.log("-------- Pool creation simulation [DONE] ---------\n")

        // versionedTxs.push(createPoolTransaction[0])

        // ---- Swap info

        const targetPoolInfo = {
            id: associatedPoolKeys.id.toString(),
            baseMint: associatedPoolKeys.baseMint.toString(),
            quoteMint: associatedPoolKeys.quoteMint.toString(),
            lpMint: associatedPoolKeys.lpMint.toString(),
            baseDecimals: associatedPoolKeys.baseDecimals,
            quoteDecimals: associatedPoolKeys.quoteDecimals,
            lpDecimals: associatedPoolKeys.lpDecimals,
            version: 4,
            programId: associatedPoolKeys.programId.toString(),
            authority: associatedPoolKeys.authority.toString(),
            openOrders: associatedPoolKeys.openOrders.toString(),
            targetOrders: associatedPoolKeys.targetOrders.toString(),
            baseVault: associatedPoolKeys.baseVault.toString(),
            quoteVault: associatedPoolKeys.quoteVault.toString(),
            withdrawQueue: associatedPoolKeys.withdrawQueue.toString(),
            lpVault: associatedPoolKeys.lpVault.toString(),
            marketVersion: 3,
            marketProgramId: associatedPoolKeys.marketProgramId.toString(),
            marketId: associatedPoolKeys.marketId.toString(),
            marketAuthority: associatedPoolKeys.marketAuthority.toString(),
            marketBaseVault: marketBaseVault.toString(),
            marketQuoteVault: marketQuoteVault.toString(),
            marketBids: marketBids.toString(),
            marketAsks: marketAsks.toString(),
            marketEventQueue: marketEventQueue.toString(),
            lookupTableAccount: PublicKey.default.toString(),
        };
        // console.log("🚀 ~ txCreateNewPoolAndBundleBuy ~ targetPoolInfo:", targetPoolInfo)

        const poolKeys = jsonInfo2PoolKeys(targetPoolInfo) as LiquidityPoolKeys;

        console.log("\n -------- Now getting swap instructions --------");

        const TOKEN_TYPE = new Token(TOKEN_PROGRAM_ID, baseMint, baseDecimals)

        // let inputTokenAmount
        // let minAmountOut
        let tokenAccountRawInfos_Swap
        let swapTransaction

        const lookupTableAccount = (
            await connection.getAddressLookupTable(lookupTableAddress)
        ).value;

        const inputTokenAmount = new TokenAmount(DEFAULT_TOKEN.WSOL, (swapSolAmount * (10 ** quoteDecimals)))
        // const minAmountOut = new TokenAmount(TOKEN_TYPE, 1)

        const baseInfo = await getMint(connection, baseMint)
        if (baseInfo == null) {
            return null
        }

        const baseDecimal = baseInfo.decimals

        for (let i = 0; i < 3; i++) {

            console.log("Processing transaction ", i + 1)

            const txs: TransactionInstruction[] = [];
            const ixs: TransactionInstruction[] = [
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 744_452 }),
                ComputeBudgetProgram.setComputeUnitLimit({ units: 1_183_504 })
            ]

            for (let j = 0; j < batchSize; j++) {
                tokenAccountRawInfos_Swap = await getWalletTokenAccount(
                    connection,
                    walletKPs[i * 7 + j].publicKey
                )
                const walletTokenAccounts = await getWalletTokenAccount(connection, walletKPs[i * 7 + j].publicKey)

                const quoteAta = await getAssociatedTokenAddress(NATIVE_MINT, walletKPs[i * 7 + j].publicKey)
                const baseAta = await getAssociatedTokenAddress(baseMint, walletKPs[i * 7 + j].publicKey)

                const keypair = walletKPs[i * 7 + j]

                const { innerTransaction: innerBuyIx } = Liquidity.makeSwapFixedInInstruction(
                    {
                        poolKeys: poolKeys,
                        userKeys: {
                            tokenAccountIn: quoteAta,
                            tokenAccountOut: baseAta,
                            owner: keypair.publicKey,
                        },
                        amountIn: new BN(swapSolAmount * 10 ** 9),
                        minAmountOut: 0,
                    },
                    poolKeys.version,
                );
                ixs.push(...innerBuyIx.instructions)

                // console.log("instructions: ", buyIxs)
            }

            const buyRecentBlockhash1 = (await connection.getLatestBlockhash().catch(async () => {
                return await connection.getLatestBlockhash().catch(getLatestBlockhashError => {
                    console.log({ getLatestBlockhashError })
                    return null
                })
            }))?.blockhash;
            if (!buyRecentBlockhash1) return { Err: "Failed to prepare transaction" }
            const lutInfo = await connection.getAccountInfo(lookupTableAddress)
            // console.log(lutInfo)

            // Step: Adding missing addresses from transaction message

            const swapVersionedTransaction1 = new VersionedTransaction(
                new TransactionMessage({
                    payerKey: LP_wallet_keypair.publicKey,
                    recentBlockhash: buyRecentBlockhash1,
                    instructions: ixs,
                }).compileToV0Message()
            );
            // console.log('Transaction size without address lookup table:    ', swapVersionedTransaction1.serialize().length, 'bytes');
            const accountKeys = swapVersionedTransaction1.message.staticAccountKeys
            const lookupTable = (await connection.getAddressLookupTable(lookupTableAddress)).value;
            const lutAddresses = lookupTable?.state.addresses
            const lutAddressesStrings = lutAddresses?.map(address => address.toString());

            const missingAddresses: PublicKey[] = []
            for (let i = 0; i < accountKeys.length; i++) {
                const accountKey = accountKeys[i].toBase58()
                if (!lutAddressesStrings?.includes(accountKey)) {
                    missingAddresses.push(accountKeys[i])
                }
            }

            // console.log("Missing addresses: ", missingAddresses)

            if (missingAddresses.length > 0) {
                console.log("Number of missing addresses: ", missingAddresses.length)
                try {
                    const numMissing = Math.ceil(missingAddresses.length / 20)
                    for (let i = 0; i < numMissing; i++) {
                        const missingSubAddresses = missingAddresses.slice(i * 20, missingAddresses.length > (i + 1) * 20 ? (i + 1) * 20 : missingAddresses.length)
                        const addAddressesInstruction = AddressLookupTableProgram.extendLookupTable({
                            payer: LP_wallet_keypair.publicKey,
                            authority: LP_wallet_keypair.publicKey,
                            lookupTable: lookupTableAddress,
                            addresses: missingSubAddresses,
                        });
                        await createAndSendV0Tx([
                            ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
                            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000 }),
                            addAddressesInstruction]);
                        console.log("Successfully added extra addresses.")
                        await sleep(5000)
                    }
                } catch (error) {
                    console.log("Error in extending missing addresses. Please retry it by pressing Enter.")
                    return
                }
            }

            if (missingAddresses.length !== 0) await sleep(40000)

            try {
                const buyRecentBlockhash = (await connection.getLatestBlockhash().catch(async () => {
                    return await connection.getLatestBlockhash().catch(getLatestBlockhashError => {
                        console.log({ getLatestBlockhashError })
                        return null
                    })
                }))?.blockhash;
                if (!buyRecentBlockhash) return { Err: "Failed to prepare transaction" }
                const swapVersionedTransaction = new VersionedTransaction(
                    new TransactionMessage({
                        payerKey: LP_wallet_keypair.publicKey,
                        recentBlockhash: buyRecentBlockhash,
                        instructions: ixs,
                    }).compileToV0Message([lookupTable!])
                );

                console.log('Transaction size with address lookup table: ', swapVersionedTransaction.serialize().length, 'bytes');

                const signers = walletKPs.slice(i * batchSize, (i + 1) * batchSize)
                swapVersionedTransaction.sign(signers)
                swapVersionedTransaction.sign([LP_wallet_keypair])

                console.log("-------- swap coin instructions [DONE] ---------\n")

                console.log((await connection.simulateTransaction(swapVersionedTransaction)))
                console.log(`------------- Simulation ${i + 1} Successful ---------`);
            } catch (error) {
                console.log("\nYou need to wait more time to use Lookuptable you just added, so please press Enter retry simulation.")
                return;
            }
        }

        await outputBalance(LP_wallet_keypair.publicKey)

        console.log("------------- All Simulation Successful ---------");
    }
}