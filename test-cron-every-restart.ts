#!/usr/bin/env tsx
/**
 * Test script to reproduce bug #13036:
 * Cron "every" schedule stops firing after gateway restart
 */

import * as fs from "fs/promises";
import * as path from "path";
import { CronService } from "./src/cron/service.js";
import { resolveCronStorePath } from "./src/cron/store.js";

const TEST_STORE_DIR = path.join(process.cwd(), "test-cron-store-every");
const TEST_STORE_PATH = path.join(TEST_STORE_DIR, "cron.json");

async function cleanupStore() {
  try {
    await fs.rm(TEST_STORE_DIR, { recursive: true, force: true });
  } catch {}
  await fs.mkdir(TEST_STORE_DIR, { recursive: true });
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("Testing cron 'every' schedule restart behavior...\n");

  // Cleanup previous test data
  await cleanupStore();

  let runCount = 0;
  const runLog: number[] = [];

  // Create first service instance
  console.log("=== Phase 1: Creating initial cron service ===");
  const service1 = new CronService({
    storePath: TEST_STORE_PATH,
    cronEnabled: true,
    log: {
      debug: (obj, msg) => console.log(`[DEBUG] ${msg}`, obj),
      info: (obj, msg) => console.log(`[INFO] ${msg}`, obj),
      warn: (obj, msg) => console.log(`[WARN] ${msg}`, obj),
      error: (obj, msg) => console.log(`[ERROR] ${msg}`, obj),
    },
    enqueueSystemEvent: (text) => {
      runCount++;
      const now = Date.now();
      runLog.push(now);
      console.log(`[RUN #${runCount}] ${new Date(now).toISOString()}: ${text}`);
    },
    requestHeartbeatNow: () => {},
    runIsolatedAgentJob: async () => ({ status: "ok" as const }),
    onEvent: (evt) => {
      console.log(`[EVENT] ${evt.action} job=${evt.jobId}`, evt);
    },
    nowMs: () => Date.now(),
  });

  await service1.start();

  // Add a job that runs every 5 seconds
  const job = await service1.add({
    name: "Test Every Job",
    enabled: true,
    schedule: {
      kind: "every",
      everyMs: 5000, // 5 seconds
    },
    sessionTarget: "main",
    payload: {
      kind: "systemEvent",
      text: "Test cron job fired!",
    },
  });

  console.log(`\nCreated job: ${job.id}`);
  console.log(`Next run at: ${new Date(job.state.nextRunAtMs!).toISOString()}`);

  // Wait for 3 runs (15 seconds)
  console.log("\n=== Waiting for 3 runs (15 seconds) ===");
  await sleep(15000);

  console.log(`\n✓ Job ran ${runCount} times before restart`);

  // Stop the service (simulate gateway stop)
  console.log("\n=== Phase 2: Stopping service (simulating gateway shutdown) ===");
  service1.stop();

  // Wait a bit to simulate downtime
  console.log("Simulating 3 seconds of downtime...");
  await sleep(3000);

  // Create new service instance (simulate gateway restart)
  console.log("\n=== Phase 3: Starting new service instance (simulating gateway restart) ===");
  const preRestartCount = runCount;

  const service2 = new CronService({
    storePath: TEST_STORE_PATH,
    cronEnabled: true,
    log: {
      debug: (obj, msg) => console.log(`[DEBUG2] ${msg}`, obj),
      info: (obj, msg) => console.log(`[INFO2] ${msg}`, obj),
      warn: (obj, msg) => console.log(`[WARN2] ${msg}`, obj),
      error: (obj, msg) => console.log(`[ERROR2] ${msg}`, obj),
    },
    enqueueSystemEvent: (text) => {
      runCount++;
      const now = Date.now();
      runLog.push(now);
      console.log(`[RUN #${runCount}] ${new Date(now).toISOString()}: ${text}`);
    },
    requestHeartbeatNow: () => {},
    runIsolatedAgentJob: async () => ({ status: "ok" as const }),
    onEvent: (evt) => {
      console.log(`[EVENT2] ${evt.action} job=${evt.jobId}`, evt);
    },
    nowMs: () => Date.now(),
  });

  await service2.start();

  // Check job status
  const jobs = await service2.list();
  if (jobs.length > 0) {
    const jobAfterRestart = jobs[0];
    console.log(`\n=== Job status after restart ===`);
    console.log(`Enabled: ${jobAfterRestart.enabled}`);
    console.log(
      `Next run at: ${jobAfterRestart.state.nextRunAtMs ? new Date(jobAfterRestart.state.nextRunAtMs).toISOString() : "undefined"}`,
    );
    console.log(
      `Last run at: ${jobAfterRestart.state.lastRunAtMs ? new Date(jobAfterRestart.state.lastRunAtMs).toISOString() : "undefined"}`,
    );
    console.log(`Running at: ${jobAfterRestart.state.runningAtMs}`);

    // Check if nextRunAtMs is in the past (should fire immediately)
    const now = Date.now();
    if (jobAfterRestart.state.nextRunAtMs && jobAfterRestart.state.nextRunAtMs <= now) {
      console.log(
        `⚠️ Next run is in the past (${now - jobAfterRestart.state.nextRunAtMs}ms ago), should fire immediately!`,
      );
    }
  }

  // Wait for more runs after restart
  console.log("\n=== Waiting for runs after restart (15 seconds) ===");
  await sleep(15000);

  const postRestartRuns = runCount - preRestartCount;
  console.log(`\n=== Final Results ===`);
  console.log(`Runs before restart: ${preRestartCount}`);
  console.log(`Runs after restart: ${postRestartRuns}`);

  if (postRestartRuns === 0) {
    console.log("\n❌ BUG REPRODUCED: Job did not run after restart!");

    // Check current state
    const finalJobs = await service2.list();
    if (finalJobs.length > 0) {
      const finalJob = finalJobs[0];
      console.log("\n=== Final job state ===");
      console.log(JSON.stringify(finalJob.state, null, 2));
    }
  } else {
    console.log(`\n✅ Job resumed correctly with ${postRestartRuns} runs after restart`);
  }

  // Analyze run intervals
  if (runLog.length > 1) {
    console.log("\n=== Run intervals ===");
    for (let i = 1; i < runLog.length; i++) {
      const interval = runLog[i] - runLog[i - 1];
      console.log(`Run ${i} → ${i + 1}: ${interval}ms (${(interval / 1000).toFixed(1)}s)`);
    }
  }

  // Cleanup
  service2.stop();
  await fs.rm(TEST_STORE_DIR, { recursive: true, force: true });
}

main().catch(console.error);
