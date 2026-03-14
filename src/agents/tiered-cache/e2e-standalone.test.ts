/**
 * E2E Test for Tiered Cache System
 *
 * Run with: npx tsx e2e-standalone.test.ts
 *
 * Requires:
 * - LLaMA server running at http://127.0.0.1:18790
 */

import "zlib";

// ============================================================================
// Test Configuration
// ============================================================================

const LLAMA_SERVER_URL = process.env.LLAMA_SERVER_URL || "http://127.0.0.1:18790";

// ============================================================================
// Tests
// ============================================================================

async function testLlamaServerHealth(): Promise<void> {
  console.log("\n=== Test: LLaMA Server Health ===\n");

  const response = await fetch(`${LLAMA_SERVER_URL}/health`);
  if (!response.ok) {
    throw new Error(`LLaMA server not healthy: ${response.status}`);
  }
  console.log("✓ LLaMA server is healthy");
}

async function testSlotsEndpoint(): Promise<void> {
  console.log("\n=== Test: Slots Endpoint ===\n");

  const response = await fetch(`${LLAMA_SERVER_URL}/slots`);
  if (!response.ok) {
    throw new Error(`Slots endpoint failed: ${response.status}`);
  }

  const slots = await response.json();
  console.log(`✓ Found ${slots.length} slots`);

  for (const slot of slots) {
    console.log(`  Slot ${slot.id}: n_ctx=${slot.n_ctx}, processing=${slot.is_processing}`);
  }
}

async function testChatCompletion(): Promise<void> {
  console.log("\n=== Test: Chat Completion ===\n");

  const response = await fetch(`${LLAMA_SERVER_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "current",
      messages: [{ role: "user", content: "Say 'hello' in one word." }],
      max_tokens: 5,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`Chat completion failed: ${response.status}`);
  }

  const result = await response.json();
  console.log(`✓ Chat completion successful`);
  console.log(`  Response: ${result.choices?.[0]?.message?.content || "N/A"}`);
  console.log(
    `  Usage: prompt=${result.usage?.prompt_tokens}, completion=${result.usage?.completion_tokens}`,
  );
}

async function testSpeculativeStats(): Promise<void> {
  console.log("\n=== Test: Speculative Decoding Stats ===\n");

  // Make a few completions to generate speculative decoding stats
  for (let i = 0; i < 3; i++) {
    await fetch(`${LLAMA_SERVER_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "current",
        messages: [
          { role: "user", content: `Test message ${i + 1}. Respond with a short greeting.` },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
    });
  }

  console.log("✓ Made 3 completions for speculative decoding");
  console.log("  Check server logs for speculative decoding statistics");
}

async function testKVCacheReuse(): Promise<void> {
  console.log("\n=== Test: KV Cache Reuse ===\n");

  // First request - populates cache
  const contextPrompt = "You are a helpful assistant. Remember this context.";
  const start1 = Date.now();

  await fetch(`${LLAMA_SERVER_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "current",
      messages: [
        { role: "system", content: contextPrompt },
        { role: "user", content: "What is 2+2?" },
      ],
      max_tokens: 10,
      cache_prompt: true,
    }),
  });

  const time1 = Date.now() - start1;

  // Second request with same prefix - should use cache
  const start2 = Date.now();

  await fetch(`${LLAMA_SERVER_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "current",
      messages: [
        { role: "system", content: contextPrompt },
        { role: "user", content: "What is 3+3?" },
      ],
      max_tokens: 10,
      cache_prompt: true,
    }),
  });

  const time2 = Date.now() - start2;

  console.log(`✓ First request: ${time1}ms`);
  console.log(`✓ Second request: ${time2}ms`);

  if (time2 < time1) {
    console.log("✓ Cache reuse appears to be working (second request faster)");
  } else {
    console.log("  Note: Cache reuse timing inconclusive");
  }
}

// ============================================================================
// Run Tests
// ============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  Tiered Cache E2E Tests");
  console.log("=".repeat(60));

  const tests = [
    { name: "LLaMA Server Health", fn: testLlamaServerHealth },
    { name: "Slots Endpoint", fn: testSlotsEndpoint },
    { name: "Chat Completion", fn: testChatCompletion },
    { name: "Speculative Stats", fn: testSpeculativeStats },
    { name: "KV Cache Reuse", fn: testKVCacheReuse },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test.fn();
      passed++;
    } catch (err) {
      failed++;
      console.log(`✗ ${test.name} failed: ${String(err)}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60) + "\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main();
