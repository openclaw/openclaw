#!/usr/bin/env node
/**
 * Test for bug #13036 fix: Cron "every" schedule stops firing after gateway restart
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { CronService } from "./dist/cron/service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_STORE_DIR = path.join(__dirname, "test-cron-fix-store");
const TEST_STORE_PATH = path.join(TEST_STORE_DIR, "cron.json");

async function cleanup() {
  try {
    await fs.rm(TEST_STORE_DIR, { recursive: true, force: true });
  } catch {}
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('Testing cron "every" schedule restart fix for bug #13036...\n');

  await cleanup();
  await fs.mkdir(TEST_STORE_DIR, { recursive: true });

  let runCount = 0;
  const runTimes = [];

  // Helper to create a cron service
  const createService = () =>
    new CronService({
      storePath: TEST_STORE_PATH,
      cronEnabled: true,
      log: {
        debug: () => {},
        info: (obj, msg) => {
          if (msg && msg.includes("running missed jobs")) {
            console.log(`[INFO] ${msg}`, obj);
          }
        },
        warn: (obj, msg) => console.log(`[WARN] ${msg}`, obj),
        error: (obj, msg) => console.log(`[ERROR] ${msg}`, obj),
      },
      enqueueSystemEvent: (text) => {
        runCount++;
        const now = Date.now();
        runTimes.push(now);
        console.log(`[RUN #${runCount}] Job fired at ${new Date(now).toISOString()}`);
      },
      requestHeartbeatNow: () => {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
      onEvent: () => {},
      nowMs: () => Date.now(),
    });

  // Phase 1: Create service and add job
  console.log("=== Phase 1: Initial setup ===");
  const service1 = createService();
  await service1.start();

  const job = await service1.add({
    name: "Test Every 3s",
    enabled: true,
    schedule: {
      kind: "every",
      everyMs: 3000, // Run every 3 seconds
    },
    sessionTarget: "main",
    payload: {
      kind: "systemEvent",
      text: "Test job fired",
    },
  });

  console.log(`Created job ${job.id}, next run: ${new Date(job.state.nextRunAtMs).toISOString()}`);

  // Wait for 2 runs (6+ seconds)
  console.log("\nWaiting 7 seconds for 2 runs...");
  await sleep(7000);

  const runsBeforeRestart = runCount;
  console.log(`✓ Job ran ${runsBeforeRestart} times before restart`);

  // Phase 2: Stop service (simulate shutdown)
  console.log("\n=== Phase 2: Simulating restart ===");
  service1.stop();

  // Wait during "downtime"
  console.log("Waiting 4 seconds (simulating downtime)...");
  await sleep(4000);

  // Phase 3: Start new service (simulate restart)
  console.log("\n=== Phase 3: After restart ===");
  const service2 = createService();
  await service2.start();

  // Check status
  const jobs = await service2.list();
  if (jobs.length > 0) {
    const jobState = jobs[0].state;
    console.log(`Job enabled: ${jobs[0].enabled}`);
    console.log(
      `Next run: ${jobState.nextRunAtMs ? new Date(jobState.nextRunAtMs).toISOString() : "undefined"}`,
    );

    const now = Date.now();
    if (jobState.nextRunAtMs && jobState.nextRunAtMs <= now) {
      console.log(
        `Note: Next run is ${Math.floor((now - jobState.nextRunAtMs) / 1000)}s in the past`,
      );
    }
  }

  // Wait for more runs
  console.log("\nWaiting 10 seconds for post-restart runs...");
  await sleep(10000);

  const runsAfterRestart = runCount - runsBeforeRestart;

  // Results
  console.log("\n=== RESULTS ===");
  console.log(`Runs before restart: ${runsBeforeRestart}`);
  console.log(`Runs after restart: ${runsAfterRestart}`);

  if (runsAfterRestart === 0) {
    console.log("\n❌ FAILED: Job did not run after restart (bug still present)");
    process.exitCode = 1;
  } else if (runsAfterRestart >= 3) {
    console.log("\n✅ PASSED: Job resumed correctly after restart");

    // Check intervals
    if (runTimes.length > 1) {
      console.log("\nRun intervals:");
      for (let i = 1; i < runTimes.length; i++) {
        const interval = runTimes[i] - runTimes[i - 1];
        console.log(`  Run ${i} → ${i + 1}: ${(interval / 1000).toFixed(1)}s`);
      }
    }
  } else {
    console.log(`\n⚠️  PARTIAL: Only ${runsAfterRestart} runs after restart (expected 3+)`);
    process.exitCode = 1;
  }

  // Cleanup
  service2.stop();
  await cleanup();
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
