// Tests for Intent Signal Layer
// Phase 5.4: Verify keyword matching, confidence scoring, intent detection

const assert = require("assert");
const { extractHints, INTENT_KEYWORDS } = require("../signals/intent-hints.cjs");

function testStockIntent() {
  const result = extractHints("2330 技術分析");
  assert.equal(result.intent, "stock");
  assert.ok(result.confidence > 0.8, `confidence should be > 0.8, got ${result.confidence}`);
  assert.equal(result.source, "signal");
}

function testCodeIntent() {
  const result = extractHints("implement a new function");
  assert.equal(result.intent, "code");
  assert.ok(result.confidence > 0.5);
}

function testDeployIntent() {
  const result = extractHints("部署到生產環境");
  assert.equal(result.intent, "deploy");
  assert.ok(result.confidence > 0.6, `confidence should be > 0.6, got ${result.confidence}`);
}

function testSystemStatusIntent() {
  const result = extractHints("系統狀態");
  assert.equal(result.intent, "system_status");
  assert.ok(result.confidence > 0.7, `confidence should be > 0.7, got ${result.confidence}`);
}

function testGmailDeleteIntent() {
  const result = extractHints("刪除郵件");
  assert.equal(result.intent, "gmail_delete");
  assert.ok(result.confidence > 0.7, `confidence should be > 0.7, got ${result.confidence}`);
}

function testHighConfidenceBypass() {
  // Multiple keywords → should exceed 0.8 threshold for Ollama bypass
  const result = extractHints("系統狀態 健康檢查 總覽");
  assert.equal(result.intent, "system_status");
  assert.ok(
    result.confidence >= 0.8,
    `multi-keyword should bypass Ollama threshold, got ${result.confidence}`,
  );
}

function testWebSearchIntent() {
  const result = extractHints("搜尋 Node.js 最新版本");
  assert.equal(result.intent, "web_search");
  assert.ok(result.confidence > 0.5);
}

function testUnknownIntent() {
  const result = extractHints("xyz random text");
  assert.equal(result.intent, "unknown");
  assert.equal(result.confidence, 0);
}

function testEmptyInput() {
  const result = extractHints("");
  assert.equal(result.intent, "chat");
  assert.equal(result.confidence, 0);
}

function testNullInput() {
  const result = extractHints(null);
  assert.equal(result.intent, "chat");
  assert.equal(result.confidence, 0);
}

function testMultipleKeywords() {
  // More keywords matched = higher confidence
  const result = extractHints("股票 台股 2330 技術分析 RSI");
  assert.equal(result.intent, "stock");
  assert.ok(
    result.confidence > 0.85,
    `multi-keyword should boost confidence, got ${result.confidence}`,
  );
  assert.ok(result.keywords_matched.length >= 3);
}

function testChineseCodeIntent() {
  const result = extractHints("實作一個新的 API endpoint");
  assert.equal(result.intent, "code");
  assert.ok(result.confidence > 0.5);
}

// Run tests
const tests = [
  testStockIntent,
  testCodeIntent,
  testDeployIntent,
  testSystemStatusIntent,
  testGmailDeleteIntent,
  testHighConfidenceBypass,
  testWebSearchIntent,
  testUnknownIntent,
  testEmptyInput,
  testNullInput,
  testMultipleKeywords,
  testChineseCodeIntent,
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    test();
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
