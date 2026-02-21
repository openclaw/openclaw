import { ZepService } from "../src/services/ZepService.js";
import { ConsolidationService } from "../src/services/ConsolidationService.js";

/**
 * Full Temporal Stress Diagnostic
 * Verifies every single human-friendly relative time label in the hybrid memory system.
 */
async function runFullTemporalDiagnostic() {
  const ZEP_URL = process.env.ZEP_API_URL || "http://127.0.0.1:8000";
  const ZEP_KEY = process.env.ZEP_API_KEY || "mindbot-10293847";

  const zep = new ZepService(ZEP_URL, ZEP_KEY);
  const consolidator = new ConsolidationService(zep);

  console.log(`\n🚀 [DIAGNOSTIC] Running Full Temporal Range Test...`);

  const now = new Date();
  const MS_PER_DAY = 1000 * 60 * 60 * 24;

  const testCases = [
    { label: "just a moment ago", offset: 1000 * 30 },
    { label: "a minute ago", offset: 1000 * 60 },
    { label: "a few minutes ago", offset: 1000 * 60 * 3 },
    { label: "about 15 minutes ago", offset: 1000 * 60 * 15 },
    { label: "almost 1h ago", offset: 1000 * 60 * 65 },
    { label: "less than 3h ago", offset: 1000 * 60 * 60 * 2.5 },
    { label: "a few hours ago", offset: 1000 * 60 * 60 * 5 },
    { label: "yesterday", offset: MS_PER_DAY * 1.2 },
    { label: "the day before yesterday", offset: MS_PER_DAY * 2.2 },
    { label: "5 days ago", offset: MS_PER_DAY * 5.2 },
    { label: "last week", offset: MS_PER_DAY * 10 },
    { label: "2 weeks ago", offset: MS_PER_DAY * 15 },
    { label: "1 month ago", offset: MS_PER_DAY * 35 },
    { label: "3 months ago", offset: MS_PER_DAY * 95 },
    { label: "almost a year ago", offset: MS_PER_DAY * 340 },
    { label: "a year and a few months ago", offset: MS_PER_DAY * 400 },
    { label: "almost 2 years ago", offset: MS_PER_DAY * 710 },
    { label: "3 years ago or so", offset: MS_PER_DAY * 365 * 3.15 },
    { label: "about 5 years ago", offset: MS_PER_DAY * 365 * 5.1 },
  ];

  const formatted = testCases.map((tc, i) => ({
    text: `Test Memory ${i}`,
    message: { created_at: new Date(now.getTime() - tc.offset).toISOString() },
  }));

  const output = consolidator.processFlashbacks(formatted);

  console.log("\n--- Generated Flashbacks Output ---");
  console.log(output);
  console.log("-----------------------------------\n");

  let passed = 0;
  testCases.forEach((tc) => {
    if (output.toLowerCase().includes(tc.label.toLowerCase())) {
      console.log(`✅ [PASS] Found label: "${tc.label}"`);
      passed++;
    } else {
      console.log(`❌ [FAIL] Missing label: "${tc.label}"`);
    }
  });

  console.log(`\n📊 Diagnostic Summary: ${passed}/${testCases.length} labels verified.`);

  if (passed === testCases.length) {
    console.log("🌟 PERFECT: All temporal senses are correctly calibrated.\n");
  } else {
    console.log("⚠️ CAUTION: Some temporal labels are not appearing as expected.\n");
  }
}

runFullTemporalDiagnostic().catch(console.error);
