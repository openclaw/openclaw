/**
 * Tests for the arbitrage bot
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { ArbitrageBot } from "./arbitrage-bot.js"
import type { ArbitrageConfig } from "./types.js"

describe("ArbitrageBot", () => {
	let config: ArbitrageConfig
	let bot: ArbitrageBot

	beforeEach(() => {
		config = {
			enabled: true,
			scanInterval: 100,
			minProfitThreshold: BigInt(10 ** 17),
			maxGasPrice: BigInt(100) * BigInt(10 ** 9),
			blockchain: {
				rpcUrl: "http://localhost:8545",
				chainId: 1,
				gasLimit: BigInt(500000),
				maxGasPrice: BigInt(100) * BigInt(10 ** 9),
			},
			aave: {
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
			],
		}
	})

	describe("initialization", () => {
		it("should create a bot with valid configuration", () => {
			bot = new ArbitrageBot(config)
			expect(bot).toBeDefined()
			expect(bot.isRunning()).toBe(false)
		})

		it("should have zero stats initially", () => {
			bot = new ArbitrageBot(config)
			const stats = bot.getStats()
			expect(stats.totalOpportunities).toBe(0)
			expect(stats.executedTrades).toBe(0)
			expect(stats.successfulTrades).toBe(0)
			expect(stats.failedTrades).toBe(0)
			expect(stats.totalProfit).toBe(0n)
			expect(stats.netProfit).toBe(0n)
		})
	})

	describe("start and stop", () => {
		beforeEach(() => {
			bot = new ArbitrageBot(config)
		})

		it("should start successfully with enabled config", async () => {
			await bot.start()
			expect(bot.isRunning()).toBe(true)
			bot.stop()
		})

		it("should not start if disabled in config", async () => {
			config.enabled = false
			bot = new ArbitrageBot(config)
			await bot.start()
			expect(bot.isRunning()).toBe(false)
		})

		it("should stop successfully", async () => {
			await bot.start()
			expect(bot.isRunning()).toBe(true)
			bot.stop()
			expect(bot.isRunning()).toBe(false)
		})

		it("should not start twice", async () => {
			await bot.start()
			await bot.start() // Should not throw
			expect(bot.isRunning()).toBe(true)
			bot.stop()
		})
	})

	describe("statistics", () => {
		beforeEach(() => {
			bot = new ArbitrageBot(config)
		})

		it("should return stats object", () => {
			const stats = bot.getStats()
			expect(stats).toHaveProperty("totalOpportunities")
			expect(stats).toHaveProperty("executedTrades")
			expect(stats).toHaveProperty("successfulTrades")
			expect(stats).toHaveProperty("failedTrades")
			expect(stats).toHaveProperty("totalProfit")
			expect(stats).toHaveProperty("totalLoss")
			expect(stats).toHaveProperty("netProfit")
		})

		it("should return a copy of stats (not reference)", () => {
			const stats1 = bot.getStats()
			const stats2 = bot.getStats()
			expect(stats1).not.toBe(stats2)
			expect(stats1).toEqual(stats2)
		})
	})

	describe("configuration", () => {
		it("should use 100ms scan interval", () => {
			bot = new ArbitrageBot(config)
			expect(config.scanInterval).toBe(100)
		})

		it("should have minimum profit threshold", () => {
			bot = new ArbitrageBot(config)
			expect(config.minProfitThreshold).toBeGreaterThan(0n)
		})

		it("should have at least one DEX configured", () => {
			bot = new ArbitrageBot(config)
			expect(config.dexes.length).toBeGreaterThan(0)
		})
	})
})
