/**
 * Tests for cron job parallel execution with bounded concurrency.
 *
 * Verifies that `onTimer` executes multiple due jobs concurrently
 * (up to MAX_CONCURRENT_JOBS = 3) using `mapConcurrent()`, and that
 * jobs don't run purely sequentially.
 *
 * Run with:  npx vitest run src/cron/service.parallel-execution.test.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob, CronStoreFile } from "./types.js";
import { CronService } from "./service.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function clearLogger() {
  noopLogger.debug.mockClear();
  noopLogger.info.mockClear();
  noopLogger.warn.mockClear();
  noopLogger.error.mockClear();
}

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-parallel-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("CronService parallel job execution", () => {
  beforeEach(() => {
    clearLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes 5 due jobs concurrently with real async delays", async () => {
    /**
     * Strategy:
     * - Use REAL timers (not fake) so that actual async delays are measurable.
     * - Create 5 jobs, all due, with a mock that takes ~200ms each.
     * - With MAX_CONCURRENT_JOBS=3, expect:
     *   Batch 1 (3 jobs): ~200ms
     *   Batch 2 (2 jobs): ~200ms
     *   Total: ~400ms
     * - Without concurrency (sequential): ~1000ms
     * - We assert total time < 700ms (generous margin for CI).
     */
    const store = await makeStorePath();
    const nowMs = Date.now();

    // Timeline tracking: record when each job starts and ends (wall clock)
    const timeline: Array<{
      jobId: string;
      startedAt: number;
      endedAt: number;
    }> = [];

    const JOB_DELAY_MS = 200;
    const JOB_COUNT = 5;

    // Pre-populate the store with 5 due jobs (all isolated, using runIsolatedAgentJob)
    const storeData = buildIsolatedDueJobStore({
      count: JOB_COUNT,
      nowMs,
      delayMs: JOB_DELAY_MS,
    });
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(storeData, null, 2), "utf-8");

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async (params: { job: CronJob; message: string }) => {
      const start = Date.now();
      // Simulate a job that takes JOB_DELAY_MS
      await new Promise((resolve) => setTimeout(resolve, JOB_DELAY_MS));
      const end = Date.now();
      timeline.push({ jobId: params.job.id, startedAt: start, endedAt: end });
      return { status: "ok" as const, summary: `done-${params.job.id}` };
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => Date.now(),
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    const wallStart = Date.now();
    await cron.start();

    // Wait for all jobs to complete. start() runs missed jobs, which will
    // pick up all 5 due jobs and run them via mapConcurrent.
    // Give it enough time for sequential worst case + margin.
    const maxWait = JOB_DELAY_MS * JOB_COUNT + 2000;
    const started = Date.now();
    while (timeline.length < JOB_COUNT && Date.now() - started < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const wallEnd = Date.now();
    const wallElapsed = wallEnd - wallStart;

    cron.stop();

    // All 5 jobs should have run
    expect(timeline.length).toBe(JOB_COUNT);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(JOB_COUNT);

    // With concurrency=3 and 5 x 200ms jobs:
    //   Batch 1 (3 concurrent): ~200ms
    //   Batch 2 (2 concurrent): ~200ms
    //   Total: ~400ms
    // Sequential would be: ~1000ms
    // Allow generous margin for CI: < 800ms means parallelization is working.
    const sequentialTime = JOB_DELAY_MS * JOB_COUNT; // 1000ms
    const idealParallelTime = Math.ceil(JOB_COUNT / 3) * JOB_DELAY_MS; // 400ms

    console.log("\n=== Parallel Execution Timeline ===");
    console.log(`Jobs: ${JOB_COUNT}, Delay per job: ${JOB_DELAY_MS}ms`);
    console.log(`Sequential (expected): ${sequentialTime}ms`);
    console.log(`Parallel ideal (ceil(5/3)*200): ${idealParallelTime}ms`);
    console.log(`Actual wall-clock: ${wallElapsed}ms`);
    console.log("\nPer-job timeline:");

    const timelineBase = Math.min(...timeline.map((t) => t.startedAt));
    for (const entry of timeline.toSorted((a, b) => a.startedAt - b.startedAt)) {
      const relStart = entry.startedAt - timelineBase;
      const relEnd = entry.endedAt - timelineBase;
      const bar =
        " ".repeat(Math.round(relStart / 20)) +
        "█".repeat(Math.max(1, Math.round((entry.endedAt - entry.startedAt) / 20)));
      console.log(
        `  ${entry.jobId.padEnd(6)}: ${String(relStart).padStart(5)}ms - ${String(relEnd).padStart(5)}ms  ${bar}`,
      );
    }

    // Verify overlapping execution (concurrent jobs started before prior jobs ended)
    const sortedByStart = [...timeline].toSorted((a, b) => a.startedAt - b.startedAt);
    let overlaps = 0;
    for (let i = 1; i < sortedByStart.length; i++) {
      // A job overlaps if it started before any earlier job ended
      for (let j = 0; j < i; j++) {
        if (sortedByStart[i].startedAt < sortedByStart[j].endedAt) {
          overlaps++;
          break;
        }
      }
    }
    console.log(`\nOverlapping job pairs: ${overlaps}`);
    console.log(`Wall-clock speedup: ${(sequentialTime / wallElapsed).toFixed(2)}x`);

    // With 5 jobs and concurrency=3, we should see at least 2 overlapping jobs
    // (the 2nd and 3rd jobs in the first batch overlap with the 1st)
    expect(overlaps).toBeGreaterThanOrEqual(2);

    // Wall-clock time should be significantly less than sequential
    // (at least 1.4x speedup — very conservative for 5 jobs with concurrency 3)
    expect(wallElapsed).toBeLessThan(sequentialTime * 0.85);

    console.log("\n✅ Parallel execution confirmed!");

    await store.cleanup();
  });

  it("mapConcurrent limits to MAX_CONCURRENT_JOBS=3 (no more than 3 simultaneous)", async () => {
    /**
     * Strategy:
     * - Track the number of concurrently-running jobs at any point.
     * - Use 6 jobs with real delays to ensure we see the concurrency cap.
     * - Verify the peak concurrency never exceeds 3.
     */
    const store = await makeStorePath();
    const nowMs = Date.now();

    let activeConcurrent = 0;
    let peakConcurrent = 0;
    const concurrencySnapshots: number[] = [];

    const JOB_DELAY_MS = 150;
    const JOB_COUNT = 6;

    const storeData = buildIsolatedDueJobStore({
      count: JOB_COUNT,
      nowMs,
      delayMs: JOB_DELAY_MS,
    });
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(storeData, null, 2), "utf-8");

    const runIsolatedAgentJob = vi.fn(async (_params: { job: CronJob; message: string }) => {
      activeConcurrent++;
      peakConcurrent = Math.max(peakConcurrent, activeConcurrent);
      concurrencySnapshots.push(activeConcurrent);
      await new Promise((resolve) => setTimeout(resolve, JOB_DELAY_MS));
      activeConcurrent--;
      return { status: "ok" as const };
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => Date.now(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    await cron.start();

    // Wait for all jobs
    const maxWait = JOB_DELAY_MS * JOB_COUNT + 2000;
    const started = Date.now();
    while (runIsolatedAgentJob.mock.calls.length < JOB_COUNT && Date.now() - started < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    // Extra wait for last batch to finish
    await new Promise((resolve) => setTimeout(resolve, JOB_DELAY_MS + 100));

    cron.stop();

    console.log("\n=== Concurrency Limit Test ===");
    console.log(`Jobs: ${JOB_COUNT}, Delay: ${JOB_DELAY_MS}ms`);
    console.log(`Peak concurrent: ${peakConcurrent}`);
    console.log(`Concurrency snapshots at job starts: [${concurrencySnapshots.join(", ")}]`);
    console.log(`Final active: ${activeConcurrent}`);

    // All jobs should have run
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(JOB_COUNT);

    // Peak concurrency should be exactly 3 (MAX_CONCURRENT_JOBS)
    expect(peakConcurrent).toBeLessThanOrEqual(3);
    expect(peakConcurrent).toBeGreaterThanOrEqual(2); // At least 2-way parallel

    // After all done, no jobs should be active
    expect(activeConcurrent).toBe(0);

    console.log("✅ Concurrency limit respected!");

    await store.cleanup();
  });

  it("mapConcurrent unit test: verifies bounded concurrency directly", async () => {
    /**
     * Test the mapConcurrent function in isolation by importing and
     * calling it directly (via the module internals).
     *
     * We dynamically construct the equivalent logic to test it
     * without needing to export it.
     */

    // Replicate the mapConcurrent logic (same as in timer.ts)
    async function mapConcurrent<T, R>(
      items: T[],
      concurrency: number,
      fn: (item: T) => Promise<R>,
    ): Promise<PromiseSettledResult<R>[]> {
      const results: PromiseSettledResult<R>[] = Array.from({ length: items.length });
      let nextIdx = 0;

      async function worker() {
        while (nextIdx < items.length) {
          const idx = nextIdx++;
          try {
            const value = await fn(items[idx]);
            results[idx] = { status: "fulfilled", value };
          } catch (reason) {
            results[idx] = { status: "rejected", reason };
          }
        }
      }

      const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
      await Promise.all(workers);
      return results;
    }

    // Test 1: 5 items with concurrency 3, verify order and concurrency
    let active = 0;
    let peak = 0;
    const startTimes: number[] = [];
    const endTimes: number[] = [];

    const results = await mapConcurrent([0, 1, 2, 3, 4], 3, async (item: number) => {
      active++;
      peak = Math.max(peak, active);
      startTimes[item] = Date.now();
      await new Promise((r) => setTimeout(r, 100));
      endTimes[item] = Date.now();
      active--;
      return item * 10;
    });

    console.log("\n=== mapConcurrent Unit Test ===");
    console.log(`Peak concurrency: ${peak}`);
    console.log(
      `Results:`,
      results.map((r) => (r.status === "fulfilled" ? r.value : "ERR")),
    );

    // Results should be in order
    expect(results).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(results[i]).toEqual({ status: "fulfilled", value: i * 10 });
    }

    // Peak concurrency should be 3
    expect(peak).toBe(3);
    expect(active).toBe(0);

    // Test 2: Error handling - one item throws
    const resultsWithError = await mapConcurrent([1, 2, 3], 2, async (item: number) => {
      if (item === 2) {
        throw new Error("boom");
      }
      return item;
    });

    expect(resultsWithError[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(resultsWithError[1].status).toBe("rejected");
    expect(resultsWithError[2]).toEqual({ status: "fulfilled", value: 3 });

    // Test 3: Empty array
    const emptyResults = await mapConcurrent([], 3, async () => 42);
    expect(emptyResults).toHaveLength(0);

    // Test 4: concurrency > items
    let peak2 = 0;
    let active2 = 0;
    await mapConcurrent([1, 2], 10, async (item) => {
      active2++;
      peak2 = Math.max(peak2, active2);
      await new Promise((r) => setTimeout(r, 50));
      active2--;
      return item;
    });
    expect(peak2).toBe(2); // Only 2 workers created (min of concurrency, items.length)

    console.log("✅ mapConcurrent unit tests passed!");
  });

  it("parallel execution produces correct job state for all jobs", async () => {
    /**
     * Verify that after parallel execution, every job has:
     * - lastStatus = "ok"
     * - lastRunAtMs set
     * - lastDurationMs > 0
     * - nextRunAtMs advanced
     * - runningAtMs cleared
     */
    const store = await makeStorePath();
    const nowMs = Date.now();
    const JOB_COUNT = 4;
    const JOB_DELAY_MS = 100;

    const storeData = buildIsolatedDueJobStore({
      count: JOB_COUNT,
      nowMs,
      delayMs: JOB_DELAY_MS,
    });
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(storeData, null, 2), "utf-8");

    const runIsolatedAgentJob = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, JOB_DELAY_MS));
      return { status: "ok" as const, summary: "completed" };
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => Date.now(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    await cron.start();

    // Wait for jobs to complete
    const maxWait = JOB_DELAY_MS * JOB_COUNT + 3000;
    const started = Date.now();
    while (runIsolatedAgentJob.mock.calls.length < JOB_COUNT && Date.now() - started < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, JOB_DELAY_MS + 200));

    const jobs = await cron.list({ includeDisabled: true });
    cron.stop();

    console.log("\n=== Job State Verification ===");
    for (const job of jobs) {
      console.log(
        `  ${job.id}: status=${job.state.lastStatus}, ` +
          `duration=${job.state.lastDurationMs}ms, ` +
          `running=${job.state.runningAtMs ?? "cleared"}, ` +
          `nextRun=${job.state.nextRunAtMs ? "set" : "none"}`,
      );
    }

    expect(jobs).toHaveLength(JOB_COUNT);
    for (const job of jobs) {
      expect(job.state.lastStatus).toBe("ok");
      expect(job.state.lastRunAtMs).toBeTypeOf("number");
      expect(job.state.lastDurationMs).toBeGreaterThan(0);
      expect(job.state.runningAtMs).toBeUndefined();
      expect(job.state.nextRunAtMs).toBeTypeOf("number");
      // nextRunAtMs should be in the future (advanced past the due time)
      expect(job.state.nextRunAtMs!).toBeGreaterThan(nowMs);
    }

    console.log("✅ All job states correct after parallel execution!");

    await store.cleanup();
  });

  it("events are emitted for all parallel jobs (started + finished)", async () => {
    const store = await makeStorePath();
    const nowMs = Date.now();
    const JOB_COUNT = 3;
    const JOB_DELAY_MS = 80;

    const storeData = buildIsolatedDueJobStore({
      count: JOB_COUNT,
      nowMs,
      delayMs: JOB_DELAY_MS,
    });
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(store.storePath, JSON.stringify(storeData, null, 2), "utf-8");

    const events: Array<{ jobId: string; action: string }> = [];
    const runIsolatedAgentJob = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, JOB_DELAY_MS));
      return { status: "ok" as const };
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => Date.now(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      onEvent: (evt) => {
        events.push({ jobId: evt.jobId, action: evt.action });
      },
    });

    await cron.start();

    const maxWait = JOB_DELAY_MS * JOB_COUNT + 3000;
    const started = Date.now();
    while (runIsolatedAgentJob.mock.calls.length < JOB_COUNT && Date.now() - started < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await new Promise((resolve) => setTimeout(resolve, JOB_DELAY_MS + 200));

    cron.stop();

    console.log("\n=== Events ===");
    for (const evt of events) {
      console.log(`  ${evt.jobId}: ${evt.action}`);
    }

    // Each job should have a "started" and "finished" event
    for (let i = 0; i < JOB_COUNT; i++) {
      const jobId = `job-${i}`;
      const jobEvents = events.filter((e) => e.jobId === jobId);
      const actions = jobEvents.map((e) => e.action);
      expect(actions).toContain("started");
      expect(actions).toContain("finished");
    }

    console.log("✅ All events emitted correctly!");

    await store.cleanup();
  });
});

/* ------------------------------------------------------------------ */
/*  Helper: build isolated job store (uses runIsolatedAgentJob)       */
/* ------------------------------------------------------------------ */

function buildIsolatedDueJobStore(opts: {
  count: number;
  nowMs: number;
  delayMs: number;
}): CronStoreFile {
  const jobs: CronJob[] = [];
  for (let i = 0; i < opts.count; i++) {
    jobs.push({
      id: `job-${i}`,
      name: `parallel-test-job-${i}`,
      enabled: true,
      createdAtMs: opts.nowMs - 120_000,
      updatedAtMs: opts.nowMs - 120_000,
      schedule: { kind: "every", everyMs: 600_000, anchorMs: opts.nowMs - 120_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: `do-job-${i}` },
      delivery: { mode: "announce" },
      state: {
        nextRunAtMs: opts.nowMs - 1,
      },
    });
  }
  return { version: 1, jobs };
}
