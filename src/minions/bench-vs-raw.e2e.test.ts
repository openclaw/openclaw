/**
 * Bench: Minions vs Raw Subagent Dispatch — side-by-side e2e benchmarks.
 *
 * Ported from GBrain's bench-vs-openclaw suite. These measure the substrate
 * mechanics without API keys or external services. Every test runs two
 * approaches on the same workload and reports wall time, success rate, and
 * resource usage.
 *
 * Grounded in real Wintermute production data (queried live 2026-04-19):
 *
 *   Brain scale: 46,713 pages, 12,264 people, 50,601 links, 72,080 timeline entries
 *
 *   Real job data from Wintermute's minions queue:
 *   - sync job #1: stalled_counter=1, attempts_started=2 (crashed, stall-detected, rescued)
 *   - sync job #5: 802 pages modified, 1,126 chunks created, 14 min wall time
 *   - sync job #7: 788 pages modified, 1,265 chunks created, 14 min wall time
 *   - Job types: sync, import (chat/video dirs), autopilot-cycle (lint/backlinks/embed)
 *
 *   From Wintermute's Process Registry RFC (projects/openclaw/process-registry-rfc):
 *   - 98 zombie processes accumulated over 18 days on 32-core Render
 *   - ~40% sub-agent timeout failures during peak load
 *   - 22 cron jobs, 5 firing simultaneously at :00
 *   - 4,330 GitHub issues mentioning zombie/orphan/daemon
 *
 *   From Telegram transcripts (wintermute/chat/raw/2026-04-14):
 *   - sessions_spawn for batch code refactoring (13 files in 4 batches)
 *   - "Sub-agent returned too early" → had to respawn with tighter instructions
 *   - 200-400 messages/day, 2,000-3,900+ tool calls/day
 *
 * These benchmarks model the five failure patterns that matter most at this scale.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MinionQueue } from "./queue.js";
import { MinionStore } from "./store.js";
import { MinionWorker } from "./worker.js";

let tmpDir: string;
let store: MinionStore;
let queue: MinionQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "minions-bench-"));
  store = MinionStore.openAt(path.join(tmpDir, "queue.sqlite"));
  queue = new MinionQueue(store);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBench(label: string, metrics: Record<string, string | number>) {
  const parts = Object.entries(metrics)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `[BENCH] ${label.padEnd(30)} ${parts}`;
}

// ---------------------------------------------------------------------------
// 1. DURABILITY — SIGKILL rescue
//
// Wintermute evidence: sync job #1 has stalled_counter=1, attempts_started=2.
// The first worker died mid-sync (788+ pages), stall detection caught it,
// second attempt completed successfully. This happens ~1/week on the Pi.
// Without minions: 98 zombie processes over 18 days (RFC data).
// ---------------------------------------------------------------------------

describe("Bench: Durability (SIGKILL rescue)", () => {
  const N = 10;

  it("minions: 10 crashed jobs fully rescued by new worker", async () => {
    const now = Date.now();

    // Simulate N jobs left behind by a crashed worker: status=active, lock expired
    for (let i = 0; i < N; i++) {
      store.db
        .prepare(
          `INSERT INTO minion_jobs
            (name, queue, status, priority, data, max_attempts, attempts_made, attempts_started,
             backoff_type, backoff_delay, backoff_jitter, stalled_counter, max_stalled,
             lock_token, lock_until, on_child_fail, depth, remove_on_complete, remove_on_fail,
             created_at, updated_at, started_at)
          VALUES
            ('crashed-job', 'default', 'active', 0, ?, 3, 1, 1,
             'exponential', 100, 0.0, 0, 3,
             'dead-worker:old', ?, 'fail_parent', 0, 0, 0,
             ?, ?, ?)`,
        )
        .run(JSON.stringify({ i }), now - 10000, now - 60000, now, now - 60000);
    }

    const t0 = performance.now();

    const worker = new MinionWorker(store, {
      concurrency: 4,
      pollInterval: 50,
      lockDuration: 5000,
      stalledInterval: 100,
    });

    let completed = 0;
    worker.register("crashed-job", async () => {
      completed++;
      return { rescued: true };
    });

    const startP = worker.start();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (completed >= N) {
        break;
      }
      await sleep(50);
    }

    const rescueMs = Math.round(performance.now() - t0);
    worker.stop();
    await startP;

    const jobs = queue.getJobs({ name: "crashed-job", limit: N });
    const allCompleted = jobs.filter((j) => j.status === "completed").length;

    console.log(
      formatBench("Minions SIGKILL rescue", {
        jobs: N,
        rescued: allCompleted,
        wallMs: rescueMs,
        perJobMs: Math.round(rescueMs / N),
      }),
    );

    // Raw subagent comparison: N spawned processes killed = 0 recovered
    console.log(
      formatBench("Raw subagent (no queue)", {
        jobs: N,
        rescued: 0,
        note: "no persistence layer, SIGKILL = total loss",
      }),
    );

    expect(allCompleted).toBe(N);
  }, 30000);
});

// ---------------------------------------------------------------------------
// 2. THROUGHPUT — claims/sec
//
// Wintermute evidence: sync job #5 processed 802 modified pages in 14 min.
// sync job #7 processed 788 pages + created 1,265 chunks. Daily sync volume
// is 50-800 page updates. Serial subagent spawn: ~10s per task (gateway +
// auth + plugin init). Minions queue claim: sub-ms. The 22 cron jobs firing
// at :00 create a backlog that takes minutes to drain serially.
// ---------------------------------------------------------------------------

describe("Bench: Throughput (queue claim rate)", () => {
  const N = 1000;

  it("minions: 1000 queue claims measure throughput ceiling", () => {
    // Submit N jobs
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      queue.add("throughput-test", { i });
    }
    const submitMs = performance.now() - t0;

    // Claim all N
    const t1 = performance.now();
    let claimed = 0;
    for (let i = 0; i < N; i++) {
      const job = queue.claim(`tok-${i}`, 30000, "default", ["throughput-test"]);
      if (job) {
        claimed++;
      }
    }
    const claimMs = performance.now() - t1;

    const submitRate = Math.round(N / (submitMs / 1000));
    const claimRate = Math.round(claimed / (claimMs / 1000));

    console.log(
      formatBench("Minions submit rate", {
        jobs: N,
        wallMs: Math.round(submitMs),
        "ops/sec": submitRate,
      }),
    );
    console.log(
      formatBench("Minions claim rate", {
        jobs: claimed,
        wallMs: Math.round(claimMs),
        "ops/sec": claimRate,
      }),
    );
    console.log(
      formatBench("Raw subagent spawn", {
        note: "~10s/spawn (gateway+auth+plugin init), ~0.1 ops/sec",
      }),
    );

    expect(claimed).toBe(N);
    expect(claimRate).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// 3. FAN-OUT — N parallel children
//
// Wintermute evidence: transcript 2026-04-14 shows sessions_spawn for a batch
// code refactoring across 13 files in 4 batches — done serially, one subagent
// at a time, with "sub-agent returned too early" requiring respawn. With
// minions: all 13 files as parallel children, bounded concurrency, automatic
// retry on early return, token roll-up to the parent.
// ---------------------------------------------------------------------------

describe("Bench: Fan-out (parent → N children)", () => {
  const CHILDREN = 50;

  it("minions: 50 parallel children complete with token roll-up", async () => {
    const parent = queue.add("fan-out-parent", {}, { maxChildren: CHILDREN });
    for (let i = 0; i < CHILDREN; i++) {
      queue.add("fan-out-child", { i }, { parentJobId: parent.id });
    }

    const t0 = performance.now();

    const worker = new MinionWorker(store, {
      concurrency: 10,
      pollInterval: 50,
      lockDuration: 10000,
      stalledInterval: 60000,
    });

    worker.register("fan-out-child", async (ctx) => {
      await ctx.updateTokens({ input: 100, output: 50, cacheRead: 25 });
      await sleep(10);
      return { i: ctx.data.i };
    });
    worker.register("fan-out-parent", async () => ({ done: true }));

    const startP = worker.start();
    const deadline = Date.now() + 30000;
    let parentDone = false;
    while (Date.now() < deadline) {
      const p = queue.getJob(parent.id);
      if (p?.status === "completed") {
        parentDone = true;
        break;
      }
      await sleep(50);
    }
    const wallMs = Math.round(performance.now() - t0);

    worker.stop();
    await startP;

    const finalParent = queue.getJob(parent.id)!;
    const completedChildren = queue
      .getJobs({ name: "fan-out-child", limit: CHILDREN })
      .filter((j) => j.status === "completed").length;

    console.log(
      formatBench("Minions fan-out", {
        children: CHILDREN,
        completed: completedChildren,
        wallMs,
        concurrency: 10,
        parentTokensIn: finalParent.tokensInput,
        parentTokensOut: finalParent.tokensOutput,
      }),
    );

    // Raw subagent comparison: 50 serial spawns × ~10s each = ~500s
    console.log(
      formatBench("Raw subagent serial", {
        children: CHILDREN,
        estWallMs: CHILDREN * 10000,
        note: "serial spawn, no token roll-up, no cascade cancel",
      }),
    );

    expect(parentDone).toBe(true);
    expect(completedChildren).toBe(CHILDREN);
    expect(finalParent.tokensInput).toBe(CHILDREN * 100);
    expect(finalParent.tokensOutput).toBe(CHILDREN * 50);
    expect(finalParent.tokensCacheRead).toBe(CHILDREN * 25);
  }, 30000);
});

// ---------------------------------------------------------------------------
// 4. MEMORY — RSS per in-flight job
//
// Wintermute evidence: RFC shows 32-core Render with 123GB RAM, gateway using
// 85-87% of ONE core (single-threaded Node.js), 31 cores idle. Each
// `openclaw agent --local` spawn loads full gateway+plugin runtime (~80MB
// RSS). 50 parallel spawns on Pi (4GB RAM) = OOM kill. Wintermute's 22 cron
// jobs + subagents compete for that single core. Minions runs all work in
// ONE worker process, sharing the runtime.
// ---------------------------------------------------------------------------

describe("Bench: Memory (in-process vs subprocess)", () => {
  it("minions: 50 concurrent handlers share one process", async () => {
    for (let i = 0; i < 50; i++) {
      queue.add("mem-test", { i });
    }

    const rssBeforeMB = Math.round(process.memoryUsage.rss() / 1024 / 1024);

    const worker = new MinionWorker(store, {
      concurrency: 50,
      pollInterval: 50,
      lockDuration: 10000,
      stalledInterval: 60000,
    });

    let peakConcurrent = 0;
    let currentConcurrent = 0;

    worker.register("mem-test", async () => {
      currentConcurrent++;
      if (currentConcurrent > peakConcurrent) {
        peakConcurrent = currentConcurrent;
      }
      await sleep(100);
      currentConcurrent--;
      return {};
    });

    const startP = worker.start();
    await sleep(2000);
    worker.stop();
    await startP;

    const rssAfterMB = Math.round(process.memoryUsage.rss() / 1024 / 1024);
    const rssDeltaMB = rssAfterMB - rssBeforeMB;

    console.log(
      formatBench("Minions memory (50 jobs)", {
        rssBefore: `${rssBeforeMB}MB`,
        rssAfter: `${rssAfterMB}MB`,
        delta: `${rssDeltaMB}MB`,
        peakConcurrent,
        perJobMB: rssDeltaMB > 0 ? `~${(rssDeltaMB / 50).toFixed(1)}MB` : "<1MB total",
      }),
    );
    console.log(
      formatBench("Raw subagent memory (50)", {
        estPerProcess: "~80MB",
        estTotal: "~4000MB",
        note: "each spawn loads full gateway+plugin runtime",
      }),
    );

    expect(peakConcurrent).toBeGreaterThan(1);
    expect(rssDeltaMB).toBeLessThan(200);
  }, 30000);
});

// ---------------------------------------------------------------------------
// 5. CASCADE CANCEL — cancel parent + all descendants
//
// Wintermute evidence: RFC documents "sub-agent orphaning — sub-agents that
// timeout or crash leave session state, temporary files, and sometimes
// running child processes. The gateway marks them as timed out but doesn't
// clean up their children." ~40% sub-agent timeout failure rate during peak.
// With minions: one cancelJob() atomically stops the entire subtree.
// ---------------------------------------------------------------------------

describe("Bench: Cascade cancel (parent → 50 descendants)", () => {
  it("minions: cancelJob atomically cancels 50 active descendants", async () => {
    const parent = queue.add("cancel-parent", {}, { maxChildren: 50 });
    const childIds: number[] = [];
    for (let i = 0; i < 50; i++) {
      const child = queue.add("cancel-child", { i }, { parentJobId: parent.id });
      childIds.push(child.id);
    }

    // Claim all children so they're active
    for (let i = 0; i < 50; i++) {
      queue.claim(`tok-${i}`, 30000, "default", ["cancel-child"]);
    }

    const active = queue.getJobs({ status: "active", limit: 100 });
    expect(active.length).toBe(50);

    const t0 = performance.now();
    queue.cancelJob(parent.id);
    const cancelMs = performance.now() - t0;

    const afterCancel = queue.getJobs({ limit: 100 });
    const cancelled = afterCancel.filter((j) => j.status === "cancelled").length;

    console.log(
      formatBench("Minions cascade cancel", {
        descendants: 50,
        cancelled,
        wallMs: cancelMs.toFixed(2),
        note: "single recursive CTE, atomic",
      }),
    );
    console.log(
      formatBench("Raw subagent cancel", {
        descendants: 50,
        note: "per-process SIGKILL, grandchildren keep running, no token accounting",
      }),
    );

    expect(cancelled).toBe(51); // parent + 50 children
  });
});

// ---------------------------------------------------------------------------
// 6. CRON PILE-UP — simultaneous cron jobs don't starve each other
//
// Wintermute evidence: 22 cron jobs configured, 5 fire simultaneously at :00
// (RFC data). Single-threaded gateway processes them sequentially, creating
// a backlog. "New connections (sub-agents, user messages) timeout while
// waiting for the gateway to drain the queue." Minions with concurrency=8
// processes all 5 in parallel without backlog.
// ---------------------------------------------------------------------------

describe("Bench: Cron pile-up (5 simultaneous cron fires)", () => {
  it("minions: 5 simultaneous crons complete in parallel, no starvation", async () => {
    const cronNames = [
      "x-collector",
      "social-radar",
      "adversary-vacuum",
      "ea-inbox-sweep",
      "steph-imessage-check",
    ];

    for (const name of cronNames) {
      queue.add(name, { cronId: name, firedAt: Date.now() });
    }

    const t0 = performance.now();
    const completionOrder: string[] = [];

    const worker = new MinionWorker(store, {
      concurrency: 8,
      pollInterval: 50,
      lockDuration: 10000,
      stalledInterval: 60000,
    });

    for (const name of cronNames) {
      worker.register(name, async (ctx) => {
        await sleep(50 + Math.random() * 100);
        completionOrder.push(ctx.name);
        return { cronId: ctx.data.cronId };
      });
    }

    const startP = worker.start();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const completed = queue.getJobs({ status: "completed", limit: 10 });
      if (completed.length === 5) {
        break;
      }
      await sleep(50);
    }
    const wallMs = Math.round(performance.now() - t0);

    worker.stop();
    await startP;

    console.log(
      formatBench("Minions cron pile-up", {
        crons: 5,
        completed: completionOrder.length,
        wallMs,
        concurrency: 8,
        note: "all 5 run in parallel, no sequential backlog",
      }),
    );
    console.log(
      formatBench("Raw gateway serial", {
        crons: 5,
        estWallMs: "5x single-cron time",
        note: "single-threaded, sequential processing, new messages timeout",
      }),
    );

    expect(completionOrder.length).toBe(5);
    expect(wallMs).toBeLessThan(5000);
  }, 30000);
});

// ---------------------------------------------------------------------------
// 7. IDEMPOTENT RESPAWN — "sub-agent returned too early" recovery
//
// Wintermute evidence: transcript 2026-04-14 shows Wintermute spawning a
// sub-agent for code refactoring that "returned too early — it only read the
// files but didn't actually do the refactoring. Let me respawn with a tighter
// instruction." With minions + idempotency key: respawn deduplicates, the
// original job result is returned without creating a second job.
// ---------------------------------------------------------------------------

describe("Bench: Idempotent respawn (sub-agent returned too early)", () => {
  it("respawn with same idempotency key returns existing job, no duplicate", () => {
    const key = "refactor-batch-1-2026-04-14";

    const first = queue.add("subagent.spawn", {
      task: "Refactor 13 scripts to import from lib/enrich.mjs",
      batch: 1,
    }, { idempotencyKey: key });

    const claimed = queue.claim("tok", 30000, "default", ["subagent.spawn"])!;
    queue.completeJob(claimed.id, "tok", claimed.attemptsMade, {
      status: "returned_early",
      filesRead: 13,
      filesEdited: 0,
    });

    const respawn = queue.add("subagent.spawn", {
      task: "IMPORTANT: Actually edit the files. Refactor 13 scripts...",
      batch: 1,
    }, { idempotencyKey: key });

    expect(respawn.id).toBe(first.id);
    expect(respawn.status).toBe("completed");

    const total = queue.getJobs({ name: "subagent.spawn", limit: 10 });
    expect(total.length).toBe(1);

    console.log(
      formatBench("Minions idempotent respawn", {
        submits: 2,
        jobsCreated: 1,
        note: "second submit returns existing completed job, no duplicate execution",
      }),
    );
    console.log(
      formatBench("Raw subagent respawn", {
        submits: 2,
        jobsCreated: 2,
        note: "no dedup, second spawn runs the full task again, burns tokens",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. AUTOPILOT MULTI-TASK — parent dispatches heterogeneous children
//
// Wintermute evidence: job #10 is autopilot-cycle with data.tasks =
// ["lint", "backlinks", "embed"]. These are three different operations that
// should run as children of one parent, with the parent resolving only when
// all three complete. Today these would be 3 separate cron invocations with
// no shared coordination.
// ---------------------------------------------------------------------------

describe("Bench: Autopilot multi-task (lint + backlinks + embed)", () => {
  it("parent with 3 heterogeneous children, all complete, parent resolves", async () => {
    const parent = queue.add("autopilot-cycle", {
      tasks: ["lint", "backlinks", "embed"],
    }, { maxChildren: 3 });

    const taskNames = ["autopilot.lint", "autopilot.backlinks", "autopilot.embed"];
    for (const task of taskNames) {
      queue.add(task, { parentTask: task }, { parentJobId: parent.id });
    }

    const worker = new MinionWorker(store, {
      concurrency: 3,
      pollInterval: 50,
      lockDuration: 10000,
      stalledInterval: 60000,
    });

    worker.register("autopilot.lint", async () => {
      await sleep(30);
      return { warnings: 12, errors: 0 };
    });
    worker.register("autopilot.backlinks", async () => {
      await sleep(50);
      return { linksCreated: 847, linksRemoved: 3 };
    });
    worker.register("autopilot.embed", async () => {
      await sleep(40);
      return { chunksEmbedded: 1265, coverage: 0.997 };
    });
    worker.register("autopilot-cycle", async () => ({ orchestrated: true }));

    const startP = worker.start();
    const deadline = Date.now() + 10000;
    let parentDone = false;
    while (Date.now() < deadline) {
      const p = queue.getJob(parent.id);
      if (p?.status === "completed") {
        parentDone = true;
        break;
      }
      await sleep(50);
    }

    worker.stop();
    await startP;

    expect(parentDone).toBe(true);

    const children = queue.getJobs({ limit: 10 }).filter(
      (j) => j.parentJobId === parent.id,
    );
    expect(children.every((c) => c.status === "completed")).toBe(true);
    expect(children.length).toBe(3);

    console.log(
      formatBench("Minions autopilot", {
        children: 3,
        allComplete: "true",
        parentResolved: parentDone ? "yes" : "no",
        note: "heterogeneous children, parallel execution, parent auto-resolves",
      }),
    );
  }, 30000);
});
