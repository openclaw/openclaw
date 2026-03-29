/**
 * Main arbitrage bot that scans and executes opportunities
 */

import { PriceScanner } from "./price-scanner.js"
import { FlashloanExecutor } from "./flashloan-executor.js"
import type { ArbitrageConfig, ArbitrageStats } from "./types.js"

export class ArbitrageBot {
	private config: ArbitrageConfig
	private scanner: PriceScanner
	private executor: FlashloanExecutor
	private stats: ArbitrageStats
	private running: boolean = false
	private scanIntervalId?: NodeJS.Timeout

	// Common token pairs to monitor
	private readonly TOKEN_PAIRS: Array<[string, string]> = [
		// Placeholder addresses - should be configured per network
		["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"], // WETH-USDC
		["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0xdAC17F958D2ee523a2206206994597C13D831ec7"], // WETH-USDT
		["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0x6B175474E89094C44Da98b954EedeAC495271d0F"], // WETH-DAI
	]

	constructor(config: ArbitrageConfig) {
		this.config = config
		this.scanner = new PriceScanner(config.dexes, config.minProfitThreshold)
		this.executor = new FlashloanExecutor(config.aave, config.blockchain)
		this.stats = {
			totalOpportunities: 0,
			executedTrades: 0,
			successfulTrades: 0,
			failedTrades: 0,
			totalProfit: 0n,
			totalLoss: 0n,
			netProfit: 0n,
			lastScanTime: 0,
			lastExecutionTime: 0,
		}
	}

	/**
	 * Start the arbitrage bot
	 */
	async start(): Promise<void> {
		if (this.running) {
			console.log("Arbitrage bot is already running")
			return
		}

		if (!this.config.enabled) {
			console.log("Arbitrage bot is disabled in configuration")
			return
		}

		console.log("Starting arbitrage bot...")
		console.log(`Scan interval: ${this.config.scanInterval}ms`)
		console.log(`Min profit threshold: ${this.config.minProfitThreshold}`)
		console.log(`Monitoring ${this.TOKEN_PAIRS.length} token pairs`)

		this.running = true

		// Start scanning loop
		this.scanIntervalId = setInterval(async () => {
			await this.scanAndExecute()
		}, this.config.scanInterval)

		// Initial scan
		await this.scanAndExecute()

		console.log("Arbitrage bot started successfully")
	}

	/**
	 * Stop the arbitrage bot
	 */
	stop(): void {
		if (!this.running) {
			console.log("Arbitrage bot is not running")
			return
		}

		console.log("Stopping arbitrage bot...")

		if (this.scanIntervalId) {
			clearInterval(this.scanIntervalId)
			this.scanIntervalId = undefined
		}

		this.running = false
		console.log("Arbitrage bot stopped")
	}

	/**
	 * Scan for opportunities and execute if found
	 */
	private async scanAndExecute(): Promise<void> {
		try {
			this.stats.lastScanTime = Date.now()

			// Scan all DEXes for prices
			await this.scanner.scanPrices(this.TOKEN_PAIRS)

			// Find arbitrage opportunities
			const opportunities = this.scanner.findOpportunities()

			if (opportunities.length > 0) {
				console.log(`Found ${opportunities.length} arbitrage opportunities`)
				this.stats.totalOpportunities += opportunities.length

				// Sort by profitability
				const sorted = opportunities.sort(
					(a, b) => Number(b.profitAfterGas - a.profitAfterGas),
				)

				// Execute the most profitable opportunity
				const bestOpportunity = sorted[0]
				if (bestOpportunity && this.executor.isReady()) {
					await this.executeOpportunity(bestOpportunity)
				}
			}

			// Clean up old price data
			this.scanner.clearOldPrices()
		} catch (error) {
			console.error("Error in scan and execute:", error)
		}
	}

	/**
	 * Execute a specific arbitrage opportunity
	 */
	private async executeOpportunity(opportunity: any): Promise<void> {
		try {
			console.log("Attempting to execute arbitrage:")
			console.log(`  Path: ${opportunity.path.join(" -> ")}`)
			console.log(`  DEXes: ${opportunity.dexes.join(" -> ")}`)
			console.log(`  Expected profit: ${opportunity.profitAfterGas}`)

			this.stats.executedTrades++
			this.stats.lastExecutionTime = Date.now()

			const result = await this.executor.executeArbitrage(opportunity)

			if (result.success) {
				this.stats.successfulTrades++
				const profit = result.profit || 0n
				this.stats.totalProfit += profit
				this.stats.netProfit = this.stats.totalProfit - this.stats.totalLoss

				console.log(`✓ Arbitrage executed successfully!`)
				console.log(`  TX Hash: ${result.txHash}`)
				console.log(`  Profit: ${profit}`)
			} else {
				this.stats.failedTrades++
				console.log(`✗ Arbitrage execution failed: ${result.error}`)
			}
		} catch (error) {
			this.stats.failedTrades++
			console.error("Error executing opportunity:", error)
		}
	}

	/**
	 * Get current statistics
	 */
	getStats(): ArbitrageStats {
		return { ...this.stats }
	}

	/**
	 * Check if bot is running
	 */
	isRunning(): boolean {
		return this.running
	}
}
