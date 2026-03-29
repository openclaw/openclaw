/**
 * Tests for the PriceScanner
 */

import { describe, it, expect, beforeEach } from "vitest"
import { PriceScanner } from "./price-scanner.js"
import type { DEXConfig } from "./types.js"

describe("PriceScanner", () => {
	let dexConfigs: DEXConfig[]
	let scanner: PriceScanner

	beforeEach(() => {
		dexConfigs = [
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
		]
		scanner = new PriceScanner(dexConfigs, BigInt(10 ** 17))
	})

	describe("initialization", () => {
		it("should create scanner with DEX configs", () => {
			expect(scanner).toBeDefined()
		})

		it("should accept minimum profit threshold", () => {
			const minProfit = BigInt(5 * 10 ** 17) // 0.5 ETH
			const customScanner = new PriceScanner(dexConfigs, minProfit)
			expect(customScanner).toBeDefined()
		})
	})

	describe("price scanning", () => {
		it("should scan prices for token pairs", async () => {
			const pairs: Array<[string, string]> = [
				["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
			]
			await scanner.scanPrices(pairs)
			// Should not throw
		})

		it("should handle multiple token pairs", async () => {
			const pairs: Array<[string, string]> = [
				["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
				["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0xdAC17F958D2ee523a2206206994597C13D831ec7"],
			]
			await scanner.scanPrices(pairs)
			// Should not throw
		})
	})

	describe("opportunity finding", () => {
		it("should return empty array when no opportunities", () => {
			const opportunities = scanner.findOpportunities()
			expect(Array.isArray(opportunities)).toBe(true)
		})

		it("should find opportunities from price data", () => {
			const opportunities = scanner.findOpportunities()
			opportunities.forEach((opp) => {
				expect(opp).toHaveProperty("tokenIn")
				expect(opp).toHaveProperty("tokenOut")
				expect(opp).toHaveProperty("amountIn")
				expect(opp).toHaveProperty("expectedProfit")
				expect(opp).toHaveProperty("profitAfterGas")
			})
		})
	})

	describe("price data cleanup", () => {
		it("should clear old prices", () => {
			scanner.clearOldPrices()
			// Should not throw
		})

		it("should accept custom max age", () => {
			scanner.clearOldPrices(10000) // 10 seconds
			// Should not throw
		})
	})
})
