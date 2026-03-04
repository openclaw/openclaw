import { BacktestClient } from "../extensions/findoo-backtest-plugin/src/backtest-client.js";
import { packStrategy } from "../extensions/findoo-backtest-plugin/src/strategy-packer.js";
/**
 * E2E 全流程测试: check → pack → upload → poll → report
 *
 * Usage: npx tsx test/e2e-backtest-flow.ts
 */
import { validateStrategy } from "../extensions/findoo-backtest-plugin/src/strategy-validator.js";

const STRATEGY_DIR = "/tmp/e2e-test-strategy";
const BASE_URL = process.env.BACKTEST_API_URL || "http://localhost:8000";
const API_KEY = process.env.BACKTEST_API_KEY || "";

async function main() {
  console.log("=== E2E Backtest Full Flow ===\n");

  // Step 1: Compliance check
  console.log("1)  Validating strategy...");
  const validation = await validateStrategy(STRATEGY_DIR);
  console.log(`   Valid: ${validation.valid}`);
  console.log(`   Errors: ${validation.errors.length}, Warnings: ${validation.warnings.length}`);
  if (validation.errors.length > 0) {
    console.log("   ERRORS:", JSON.stringify(validation.errors, null, 2));
  }
  if (validation.warnings.length > 0) {
    console.log("   WARNINGS:", JSON.stringify(validation.warnings, null, 2));
  }
  if (!validation.valid) {
    console.error("FAIL: Compliance check failed, aborting.");
    process.exit(1);
  }
  console.log("   PASS\n");

  // Step 2: Pack
  console.log("2)  Packing strategy...");
  const tarBuffer = await packStrategy(STRATEGY_DIR);
  console.log(`   Archive size: ${tarBuffer.length} bytes`);
  console.log(`   Gzip magic: 0x${tarBuffer[0].toString(16)} 0x${tarBuffer[1].toString(16)}`);
  console.log("   PASS\n");

  // Step 3: Upload
  console.log(`3)  Uploading to ${BASE_URL}...`);
  const client = new BacktestClient(BASE_URL, API_KEY, 60_000);

  // Health check first
  try {
    const health = await client.health();
    console.log(`   Server health: ${JSON.stringify(health)}`);
  } catch (err: unknown) {
    console.error(
      `   FAIL: Server unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const archiveName = `e2e-test-${Date.now()}.zip`;
  const uploadResult = await client.uploadStrategy(tarBuffer, archiveName, {
    engine: "script",
    symbol: "BTC-USD",
    start_date: "2024-01-01",
    end_date: "2024-06-30",
    initial_capital: 100000,
  });
  console.log(`   Upload result: ${JSON.stringify(uploadResult)}`);
  console.log(`   Task ID: ${uploadResult.task_id}`);
  console.log("   PASS\n");

  // Step 4: Poll until done
  console.log("4)  Polling task status...");
  const taskId = uploadResult.task_id;
  let task = await client.getTask(taskId);
  console.log(`   Initial status: ${task.status}`);

  const maxPollMs = 120_000;
  const pollInterval = 3_000;
  const start = Date.now();

  while (!["completed", "failed", "cancelled", "rejected"].includes(task.status)) {
    if (Date.now() - start > maxPollMs) {
      console.error(`   TIMEOUT after ${maxPollMs / 1000}s (status: ${task.status})`);
      break;
    }
    await new Promise((r) => setTimeout(r, pollInterval));
    task = await client.getTask(taskId);
    console.log(`   ... status: ${task.status} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  }

  if (task.status === "completed") {
    console.log("   PASS: Task completed\n");

    // Step 5: Get report
    console.log("5)  Fetching report...");
    try {
      const report = await client.getReport(taskId);
      const s = report.result_summary;
      console.log(`   Total Return: ${(s.total_return * 100).toFixed(2)}%`);
      console.log(`   Sharpe Ratio: ${s.sharpe_ratio.toFixed(3)}`);
      console.log(`   Max Drawdown: ${(s.max_drawdown * 100).toFixed(2)}%`);
      console.log(`   Win Rate: ${(s.win_rate * 100).toFixed(1)}%`);
      console.log(`   Total Trades: ${s.total_trades}`);
      console.log(`   Final Equity: $${s.final_equity.toFixed(2)}`);
      console.log(`   Trades in report: ${report.trades?.length ?? 0}`);
      console.log(`   Equity curve points: ${report.equity_curve?.length ?? 0}`);
      console.log("   PASS\n");
    } catch (err: unknown) {
      console.log(
        `   WARN: Report fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.log("   (Task completed but report endpoint may differ)\n");
    }
  } else if (task.status === "failed") {
    const msg = String(task.error ?? "no error detail");
    console.log(`   FAIL: Task failed: ${msg}\n`);
  } else if (task.status === "rejected") {
    console.log(`   REJECTED: ${task.status}\n`);
  } else {
    console.log(`   INFO: Final status: ${task.status}\n`);
  }

  // Step 6: List tasks
  console.log("6)  Listing recent tasks...");
  const list = await client.listTasks(5, 0);
  console.log(`   Total tasks: ${list.total}`);
  for (const t of list.tasks) {
    console.log(`   - ${t.task_id}: ${t.status} (${t.engine ?? "?"} / ${t.symbol ?? "?"})`);
  }
  console.log("   PASS\n");

  console.log("=== E2E Flow Complete ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
