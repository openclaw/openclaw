import { ZepService } from "../src/services/ZepService.js";
import { ConsolidationService } from "../src/services/ConsolidationService.js";

async function runEndToEndTemporalTest() {
  const ZEP_URL = process.env.ZEP_API_URL || "http://127.0.0.1:8000";
  const ZEP_KEY = process.env.ZEP_API_KEY || "mindbot-10293847";
  const TEST_SESSION = "e2e-temporal-" + Math.floor(Math.random() * 10000);

  console.log(`\n🚀 [E2E TEST] End-to-End Temporal Memory Test [Session: ${TEST_SESSION}]`);
  const zep = new ZepService(ZEP_URL, ZEP_KEY);
  const consolidator = new ConsolidationService(zep);

  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  const now = new Date();

  // 1. Facts with varied historical timestamps
  const historicalFacts = [
    { text: "Julio lived in London.", date: new Date(now.getTime() - MS_PER_DAY * 400) }, // ~1.1 years
    { text: "Julio prefers tea over coffee.", date: new Date(now.getTime() - MS_PER_DAY * 10) }, // 10 days
    { text: "Julio just finished a marathon.", date: new Date(now.getTime() - 1000 * 60 * 10) }, // 10 mins
  ];

  console.log("\n📥 Step 1: Injecting historical facts into Zep...");
  for (const f of historicalFacts) {
    console.log(`   ✨ Storing: "${f.text}" with date ${f.date.toISOString()}`);
    // Note: Zep Community might ignore the override and use current server time,
    // but we send it just in case.
    await zep.addMemory(TEST_SESSION, "human", f.text, f.date.toISOString());
  }

  // 2. Wait for indexing
  console.log("\n⏳ Step 2: Waiting for Zep indexing...");
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // 3. Retrieval and Processing
  console.log("\n🔍 Step 3: Retrieving and Processing Flashbacks...");
  const results = await zep.searchMemory(TEST_SESSION, "Tell me about Julio", 5);

  if (results && results.length > 0) {
    console.log(`   ✅ Found ${results.length} memories.`);
    const processed = consolidator.processFlashbacks(results);
    console.log("\n📊 PROCESSED OUTPUT (How Joju sees it):");
    console.log("--------------------------------------------------");
    console.log(processed);
    console.log("--------------------------------------------------");
  } else {
    console.log("   ❌ No memories retrieved from Zep.");
  }

  console.log("\n🏁 E2E Test Finished.\n");
}

runEndToEndTemporalTest().catch(console.error);
