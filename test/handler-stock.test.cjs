// Tests for stock handler
// Phase 5.4: Handler test skeleton

const assert = require("assert");
const handler = require("../handlers/stock.cjs");

const mockDeps = {
  detectStockSymbol: (text) => {
    const match = text.match(/\b(\d{4,6})\b/);
    if (match) {
      return match[1];
    }
    if (text.includes("台積電")) {
      return "2330";
    }
    return null;
  },
  fetchTaiwanStockIndicators: async (symbol) => {
    if (symbol === "2330") {
      return {
        stock_name: "台積電",
        stock_id: "2330",
        latest_close: 850.0,
        ma_5: 845.2,
        ma_20: 830.1,
        rsi_14: 65.3,
        macd: 2.1,
        trend_signal: "偏多",
      };
    }
    throw new Error(`${symbol} 暫無數據`);
  },
  detectFinancialIntent: (text) => {
    if (text.includes("投資")) {
      return { keywords: ["投資"] };
    }
    return null;
  },
};

handler.init(mockDeps);

async function testStockMatch() {
  const result = handler.match({ userText: "2330 技術分析" });
  assert.ok(result);
  assert.equal(result.type, "stock");
  assert.equal(result.stockSymbol, "2330");
}

async function testFinancialMatch() {
  const result = handler.match({ userText: "投資建議" });
  assert.ok(result);
  assert.equal(result.type, "financial");
}

async function testNoMatch() {
  const result = handler.match({ userText: "你好" });
  assert.ok(!result);
}

async function testStockExecute() {
  const ctx = { userText: "2330", stockSymbol: "2330", type: "stock" };
  const result = await handler.execute(ctx);
  assert.equal(result.status, "handled");
  assert.ok(result.body.includes("台積電"));
  assert.ok(result.body.includes("850.00"));
  assert.equal(result.executor, "claude");
}

async function testStockError() {
  const ctx = { userText: "9999", stockSymbol: "9999", type: "stock" };
  const result = await handler.execute(ctx);
  assert.equal(result.status, "pass");
  assert.ok(result.skillContext.includes("暫時不可用"));
}

void (async () => {
  const tests = [testStockMatch, testFinancialMatch, testNoMatch, testStockExecute, testStockError];
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
      console.log(`  ✓ ${test.name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${test.name}: ${e.message}`);
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})();
