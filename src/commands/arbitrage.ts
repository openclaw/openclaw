/**
 * Arbitrage command for managing the Aave flashloan arbitrage bot
 */

import { Command } from "commander"
import { ArbitrageBot } from "../defi/arbitrage-bot.js"
import type { ArbitrageConfig } from "../defi/types.js"

export function createArbitrageCommand(): Command {
	const cmd = new Command("arbitrage")
		.description("Manage Aave flashloan arbitrage bot")
		.addCommand(createStartCommand())
		.addCommand(createStopCommand())
		.addCommand(createStatusCommand())
		.addCommand(createConfigCommand())

	return cmd
}

function createStartCommand(): Command {
	return new Command("start")
		.description("Start the arbitrage bot")
		.action(async () => {
			try {
				const config = getDefaultConfig()
				const bot = new ArbitrageBot(config)

				console.log("Starting arbitrage bot...")
				await bot.start()

				// Keep process running
				process.on("SIGINT", () => {
					console.log("\nShutting down...")
					bot.stop()
					process.exit(0)
				})

				process.on("SIGTERM", () => {
					bot.stop()
					process.exit(0)
				})
			} catch (error) {
				console.error("Failed to start arbitrage bot:", error)
				process.exit(1)
			}
		})
}

function createStopCommand(): Command {
	return new Command("stop")
		.description("Stop the arbitrage bot")
		.action(async () => {
			console.log("Stop command - bot should be managed via process signals")
		})
}

function createStatusCommand(): Command {
	return new Command("status")
		.description("Show arbitrage bot statistics")
		.action(async () => {
			try {
				// TODO: Implement status retrieval from running bot
				// This would require IPC or a shared stats file
				console.log("Arbitrage Bot Status")
				console.log("===================")
				console.log("Status: Not implemented yet")
				console.log("Use the start command to run the bot")
			} catch (error) {
				console.error("Failed to get status:", error)
				process.exit(1)
			}
		})
}

function createConfigCommand(): Command {
	return new Command("config")
		.description("Show current configuration")
		.action(async () => {
			const config = getDefaultConfig()
			console.log("Arbitrage Configuration")
			console.log("======================")
			console.log(JSON.stringify(config, null, 2))
		})
}

/**
 * Get default arbitrage configuration
 * TODO: Load from config file or environment variables
 */
function getDefaultConfig(): ArbitrageConfig {
	return {
		enabled: true,
		scanInterval: 100, // 100ms as requested
		minProfitThreshold: BigInt(10 ** 17), // 0.1 ETH minimum profit
		maxGasPrice: BigInt(100) * BigInt(10 ** 9), // 100 gwei max
		blockchain: {
			rpcUrl: process.env.ETH_RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/demo",
			chainId: 1, // Ethereum mainnet
			privateKey: process.env.PRIVATE_KEY, // WARNING: Handle securely!
			gasLimit: BigInt(500000),
			maxGasPrice: BigInt(100) * BigInt(10 ** 9),
		},
		aave: {
			// Ethereum mainnet addresses
			poolAddressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
			pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
			dataProvider: "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3",
			weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
		},
		dexes: [
			{
				name: "Uniswap V2",
				router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
				factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
				fee: 3000,
			},
			{
				name: "Sushiswap",
				router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
				factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
				fee: 3000,
			},
		],
	}
}
