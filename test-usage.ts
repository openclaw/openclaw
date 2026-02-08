import { loadCostUsageSummary } from "./src/infra/session-cost-usage.js";
import { formatUsd, formatTokenCount } from "./src/utils/usage-format.js";

async function test() {
  const durationMs = 24 * 60 * 60 * 1000;
  const startMs = Date.now() - durationMs;
  const summary = await loadCostUsageSummary({ startMs, endMs: Date.now() });

  console.log("Summary for 24h:");
  console.log("Total Tokens:", formatTokenCount(summary.totals.totalTokens));
  console.log("Total Cost:", formatUsd(summary.totals.totalCost));
  console.log("Models:", summary.models.map((m) => m.model).join(", "));
  if (summary.models.length > 0) {
    console.log("First model details:", JSON.stringify(summary.models[0], null, 2));
  }
}

test().catch(console.error);
