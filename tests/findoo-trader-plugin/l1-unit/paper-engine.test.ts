/**
 * L1 Unit Tests — Paper Engine (PaperAccount + PaperEngine integration via mocks)
 *
 * Covers:
 * - Account creation / state retrieval
 * - Buy order execution with slippage + commission
 * - Sell order execution and position closure
 * - Insufficient cash rejection
 * - Insufficient position rejection
 * - PnL calculation after price update
 * - Average-in position cost calculation
 * - A-share lot size validation (must be multiple of 100 for buy)
 * - A-share price limit ±10% rejection
 * - A-share ST stock price limit ±5%
 * - Crypto 24/7 market always open
 * - T+1 settlement: cannot sell same-day purchases
 * - Equity = cash + positionsValue
 */

import { describe, it, expect } from "vitest";
import { calculateCommission } from "../../../extensions/findoo-trader-plugin/src/paper/fill-simulation/commission-model.js";
import { validateLotSize } from "../../../extensions/findoo-trader-plugin/src/paper/market-rules/lot-size-validator.js";
import {
  resolveMarket,
  isMarketOpen,
} from "../../../extensions/findoo-trader-plugin/src/paper/market-rules/market-calendar.js";
import { checkPriceLimit } from "../../../extensions/findoo-trader-plugin/src/paper/market-rules/price-limit-validator.js";
import { PaperAccount } from "../../../extensions/findoo-trader-plugin/src/paper/paper-account.js";
import { applyConstantSlippage } from "../../../extensions/findoo-trader-plugin/src/shared/fill-simulation.js";

describe("PaperAccount — creation and state", () => {
  it("should create an account with correct initial state", () => {
    const account = new PaperAccount({ id: "test-1", name: "Test", initialCapital: 100_000 });
    const state = account.getState();

    expect(state.id).toBe("test-1");
    expect(state.name).toBe("Test");
    expect(state.initialCapital).toBe(100_000);
    expect(state.cash).toBe(100_000);
    expect(state.equity).toBe(100_000);
    expect(state.positions).toHaveLength(0);
    expect(state.orders).toHaveLength(0);
  });

  it("should restore state via fromState round-trip", () => {
    const account = new PaperAccount({ id: "test-2", name: "Restored", initialCapital: 50_000 });
    account.executeBuy({
      symbol: "BTC/USDT",
      quantity: 1,
      fillPrice: 40_000,
      commission: 40,
      slippage: 20,
    });
    const snapshot = account.getState();
    const restored = PaperAccount.fromState(snapshot);
    const restoredState = restored.getState();

    expect(restoredState.cash).toBe(snapshot.cash);
    expect(restoredState.positions).toHaveLength(1);
    expect(restoredState.positions[0].symbol).toBe("BTC/USDT");
  });
});

describe("PaperAccount — buy execution with slippage + commission", () => {
  it("should deduct cost = fillPrice * qty + commission from cash", () => {
    const account = new PaperAccount({ id: "b-1", name: "Buy", initialCapital: 100_000 });
    const order = account.executeBuy({
      symbol: "ETH/USDT",
      quantity: 10,
      fillPrice: 3000,
      commission: 30,
      slippage: 15,
    });

    expect(order.status).toBe("filled");
    expect(order.fillPrice).toBe(3000);
    expect(order.commission).toBe(30);

    const state = account.getState();
    // cost = 3000 * 10 + 30 = 30030
    expect(state.cash).toBeCloseTo(100_000 - 30_030, 2);
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0].quantity).toBe(10);
    expect(state.positions[0].entryPrice).toBe(3000);
  });

  it("should reject buy when cash is insufficient", () => {
    const account = new PaperAccount({ id: "b-2", name: "NoCash", initialCapital: 1000 });
    const order = account.executeBuy({
      symbol: "BTC/USDT",
      quantity: 1,
      fillPrice: 50_000,
      commission: 50,
      slippage: 25,
    });

    expect(order.status).toBe("rejected");
    // Cash unchanged
    expect(account.getState().cash).toBe(1000);
  });
});

describe("PaperAccount — sell execution", () => {
  it("should credit proceeds = fillPrice * qty - commission to cash", () => {
    const account = new PaperAccount({ id: "s-1", name: "Sell", initialCapital: 100_000 });
    account.executeBuy({
      symbol: "BTC/USDT",
      quantity: 2,
      fillPrice: 40_000,
      commission: 80,
      slippage: 0,
    });

    const sellOrder = account.executeSell({
      symbol: "BTC/USDT",
      quantity: 2,
      fillPrice: 42_000,
      commission: 84,
      slippage: 0,
    });

    expect(sellOrder.status).toBe("filled");
    // After buy: cash = 100000 - (40000*2 + 80) = 19920
    // After sell: cash = 19920 + (42000*2 - 84) = 19920 + 83916 = 103836
    expect(account.getState().cash).toBeCloseTo(103_836, 2);
    expect(account.getState().positions).toHaveLength(0);
  });

  it("should reject sell when position is insufficient", () => {
    const account = new PaperAccount({ id: "s-2", name: "NoPos", initialCapital: 100_000 });
    const order = account.executeSell({
      symbol: "BTC/USDT",
      quantity: 1,
      fillPrice: 40_000,
      commission: 40,
      slippage: 0,
    });

    expect(order.status).toBe("rejected");
  });
});

describe("PaperAccount — PnL calculation", () => {
  it("should calculate unrealizedPnl correctly after price update", () => {
    const account = new PaperAccount({ id: "pnl-1", name: "PnL", initialCapital: 100_000 });
    account.executeBuy({
      symbol: "BTC/USDT",
      quantity: 1,
      fillPrice: 40_000,
      commission: 40,
      slippage: 0,
    });

    // Price goes up to 42000
    account.updatePrices({ "BTC/USDT": 42_000 });

    const pos = account.getPosition("BTC/USDT")!;
    expect(pos.unrealizedPnl).toBeCloseTo(2_000, 2); // (42000 - 40000) * 1
    expect(pos.currentPrice).toBe(42_000);
  });

  it("should compute equity = cash + sum(currentPrice * qty)", () => {
    const account = new PaperAccount({ id: "pnl-2", name: "Equity", initialCapital: 100_000 });
    account.executeBuy({
      symbol: "ETH/USDT",
      quantity: 10,
      fillPrice: 3000,
      commission: 30,
      slippage: 0,
    });
    // cash = 100000 - (30000 + 30) = 69970
    // equity = 69970 + 3000*10 = 99970  (lost 30 to commission)
    expect(account.getEquity()).toBeCloseTo(99_970, 2);

    account.updatePrices({ "ETH/USDT": 3200 });
    // equity = 69970 + 3200*10 = 101970
    expect(account.getEquity()).toBeCloseTo(101_970, 2);
  });
});

describe("PaperAccount — average-in position cost", () => {
  it("should compute weighted average entry price when buying into existing position", () => {
    const account = new PaperAccount({ id: "avg-1", name: "AvgIn", initialCapital: 200_000 });
    account.executeBuy({
      symbol: "BTC/USDT",
      quantity: 1,
      fillPrice: 40_000,
      commission: 0,
      slippage: 0,
    });
    account.executeBuy({
      symbol: "BTC/USDT",
      quantity: 1,
      fillPrice: 44_000,
      commission: 0,
      slippage: 0,
    });

    const pos = account.getPosition("BTC/USDT")!;
    expect(pos.quantity).toBe(2);
    // Weighted average = (40000*1 + 44000*1) / 2 = 42000
    expect(pos.entryPrice).toBeCloseTo(42_000, 2);
  });
});

describe("Slippage model", () => {
  it("should increase fill price for buy orders", () => {
    const { fillPrice, slippageCost } = applyConstantSlippage(10_000, "buy", 5);
    // 5 bps = 0.05% of 10000 = 5
    expect(slippageCost).toBeCloseTo(5, 2);
    expect(fillPrice).toBeCloseTo(10_005, 2);
  });

  it("should decrease fill price for sell orders", () => {
    const { fillPrice, slippageCost } = applyConstantSlippage(10_000, "sell", 5);
    expect(slippageCost).toBeCloseTo(5, 2);
    expect(fillPrice).toBeCloseTo(9_995, 2);
  });
});

describe("Commission model", () => {
  it("should apply stamp duty on sell for cn_a_share", () => {
    const { commission } = calculateCommission(100_000, "cn_a_share", { side: "sell" });
    // taker = 0.0003 * 100000 = 30, stampDuty = 0.001 * 100000 = 100, total = 130
    expect(commission).toBeCloseTo(130, 2);
  });

  it("should not apply stamp duty on buy for cn_a_share", () => {
    const { commission } = calculateCommission(100_000, "cn_a_share", { side: "buy" });
    // taker only = 0.0003 * 100000 = 30
    expect(commission).toBeCloseTo(30, 2);
  });

  it("should return 0 for zero notional", () => {
    const { commission } = calculateCommission(0, "crypto");
    expect(commission).toBe(0);
  });
});

describe("Market rules — lot size", () => {
  it("should reject A-share buy that is not a multiple of 100", () => {
    const result = validateLotSize("cn_a_share", "buy", 150);
    expect(result.valid).toBe(false);
  });

  it("should accept A-share buy that is a multiple of 100", () => {
    const result = validateLotSize("cn_a_share", "buy", 200);
    expect(result.valid).toBe(true);
  });

  it("should accept crypto buy of any fractional quantity", () => {
    const result = validateLotSize("crypto", "buy", 0.001);
    expect(result.valid).toBe(true);
  });
});

describe("Market rules — price limit", () => {
  it("should reject A-share price exceeding ±10% of prevClose", () => {
    // prevClose=10, fillPrice=11.5 → exceeds +10% limit (upper=11)
    const result = checkPriceLimit("cn_a_share", "600001.SH", 11.5, 10);
    expect(result.valid).toBe(false);
    expect(result.upperLimit).toBeCloseTo(11, 2);
  });

  it("should accept A-share price within ±10%", () => {
    const result = checkPriceLimit("cn_a_share", "600001.SH", 10.5, 10);
    expect(result.valid).toBe(true);
  });

  it("should apply ±5% limit for ST stocks", () => {
    // ST stock: limit is 5%, prevClose=10 → upper=10.5
    const result = checkPriceLimit("cn_a_share", "600001.SH", 10.6, 10, { isSt: true });
    expect(result.valid).toBe(false);
  });

  it("should apply ±20% for ChiNext/STAR board (300xxx, 688xxx)", () => {
    const result = checkPriceLimit("cn_a_share", "300001.SZ", 12.5, 10);
    // 20% limit → upper=12, 12.5 > 12 → invalid
    expect(result.valid).toBe(false);
  });

  it("should skip price limit for crypto (not enabled)", () => {
    const result = checkPriceLimit("crypto", "BTC/USDT", 999_999, 50_000);
    expect(result.valid).toBe(true);
  });
});

describe("Market calendar", () => {
  it("should resolve crypto symbols by '/' separator", () => {
    expect(resolveMarket("BTC/USDT")).toBe("crypto");
    expect(resolveMarket("ETH/BTC")).toBe("crypto");
  });

  it("should resolve A-share by .SH/.SZ suffix", () => {
    expect(resolveMarket("600001.SH")).toBe("cn_a_share");
    expect(resolveMarket("000001.SZ")).toBe("cn_a_share");
  });

  it("should resolve HK equity by .HK suffix", () => {
    expect(resolveMarket("0700.HK")).toBe("hk_equity");
  });

  it("should report crypto market as always open", () => {
    // Crypto has empty sessions → always open
    expect(isMarketOpen("crypto")).toBe(true);
  });
});

describe("T+1 settlement", () => {
  it("should prevent selling shares bought today (settlableAfter in future)", () => {
    const account = new PaperAccount({ id: "t1-1", name: "T+1", initialCapital: 100_000 });
    const futureTimestamp = Date.now() + 86_400_000; // T+1
    account.executeBuy({
      symbol: "600001.SH",
      quantity: 100,
      fillPrice: 10,
      commission: 3,
      slippage: 0,
      settlableAfter: futureTimestamp,
    });

    // Sellable now should be 0 since lot is not yet settlable
    const sellable = account.getSellableQuantity("600001.SH");
    expect(sellable).toBe(0);
  });

  it("should allow selling after settlement period", () => {
    const account = new PaperAccount({ id: "t1-2", name: "T+1 settled", initialCapital: 100_000 });
    const pastTimestamp = Date.now() - 1000; // Already settled
    account.executeBuy({
      symbol: "600001.SH",
      quantity: 100,
      fillPrice: 10,
      commission: 3,
      slippage: 0,
      settlableAfter: pastTimestamp,
    });

    const sellable = account.getSellableQuantity("600001.SH");
    expect(sellable).toBe(100);
  });
});
