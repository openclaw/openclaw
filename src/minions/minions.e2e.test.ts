/**
 * E2E Minions Tests — ported from GBrain's Postgres e2e suite.
 *
 * GBrain tests prove FOR UPDATE SKIP LOCKED correctness under real PG
 * concurrency. These prove the same five scenarios under SQLite's
 * single-writer (BEGIN IMMEDIATE) model. Same guarantees, different
 * serialization mechanism.
 *
 * 1. Concurrent claim → 20 jobs, 2 workers, exactly 20 unique completions
 * 2. Runaway handler → timeout dead-letters within 2s
 * 3. Crash rescue → stall detection re-queues orphaned jobs
 * 4. Deep tree fan-in → child_done propagates through multi-level trees
 * 5. Cascade kill → cancelJob aborts live descendants
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MinionQueue } from "./queue.js";
import { MinionStore } from "./store.js";
import { MinionWorker } from "./worker.js";

let tmpDir: string;
let store: MinionStore;
let queue: MinionQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "minions-e2e-"));
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

describe("E2E: concurrent claim", () => {
  it("2 workers + 20 jobs → exactly 20 unique completions", async () => {
    for (let i = 0; i < 20; i++) {
      queue.add("echo", { i });
    }

    const claimedByA: number[] = [];
    const claimedByB: number[] = [];

    const workerA = new MinionWorker(store, {
      concurrency: 4,
      pollInterval: 50,
      lockDuration: 10000,
      stalledInterval: 60000,
    });
    const workerB = new MinionWorker(store, {
      concurrency: 4,
      pollInterval: 50,
      lockDuration: 10000,
      stalledInterval: 60000,
    });

    workerA.register("echo", async (ctx) => {
      claimedByA.push(ctx.id);
      await sleep(10);
      return { by: "A" };
    });
    workerB.register("echo", async (ctx) => {
      claimedByB.push(ctx.id);
      await sleep(10);
      return { by: "B" };
    });

    const startA = workerA.start();
    const startB = workerB.start();

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const completed = queue.getJobs({ status: "completed", limit: 100 });
      if (completed.length === 20) {
        break;
      }
      await sleep(50);
    }

    workerA.stop();
    workerB.stop();
    await Promise.all([startA, startB]);

    const totalClaimed = claimedByA.length + claimedByB.length;
    expect(totalClaimed).toBe(20);

    const allIds = [...claimedByA, ...claimedByB];
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(20);

    const overlap = claimedByA.filter((id) => claimedByB.includes(id));
    expect(overlap).toHaveLength(0);

    expect(claimedByA.length).toBeGreaterThan(0);
    expect(claimedByB.length).toBeGreaterThan(0);
  }, 30000);
});

describe("E2E: runaway handler timeout", () => {
  it("dead-letters a handler that ignores AbortSignal within 2s", async () => {
    const worker = new MinionWorker(store, {
      concurrency: 1,
      pollInterval: 50,
      lockDuration: 30000,
      stalledInterval: 200,
    });

    worker.register("runaway", async () => {
      await sleep(10000);
      return { ok: true };
    });

    const job = queue.add("runaway", {}, { timeoutMs: 500, maxAttempts: 1 });
    const started = Date.now();
    const startP = worker.start();

    let finalStatus = "";
    let deadAt = 0;
    while (Date.now() - started < 5000) {
      const j = queue.getJob(job.id);
      if (j && (j.status === "dead" || j.status === "failed")) {
        finalStatus = j.status;
        deadAt = Date.now();
        break;
      }
      await sleep(50);
    }

    expect(finalStatus).toBe("dead");
    expect(deadAt - started).toBeLessThan(3000);
    expect(queue.getJob(job.id)!.errorText).toMatch(/timeout exceeded/i);

    worker.stop();
    await startP;
  }, 30000);
});

describe("E2E: crash rescue via stall detection", () => {
  it("stalled job is re-queued and completed by a rescue worker", async () => {
    const now = Date.now();
    store.db
      .prepare(
        `INSERT INTO minion_jobs
          (name, queue, status, priority, data, max_attempts, attempts_made, attempts_started,
           backoff_type, backoff_delay, backoff_jitter, stalled_counter, max_stalled,
           lock_token, lock_until, on_child_fail, depth, remove_on_complete, remove_on_fail,
           created_at, updated_at, started_at)
        VALUES
          ('rescue-me', 'default', 'active', 0, '{}', 3, 1, 1,
           'exponential', 1000, 0.25, 0, 3,
           'crashed-worker:123', ?, 'fail_parent', 0, 0, 0,
           ?, ?, ?)`,
      )
      .run(now - 10000, now - 60000, now, now - 60000);

    const jobId = (
      store.db.prepare("SELECT id FROM minion_jobs WHERE name = 'rescue-me'").get() as {
        id: number | bigint;
      }
    ).id;
    const id = typeof jobId === "bigint" ? Number(jobId) : jobId;

    let ran = false;
    const worker = new MinionWorker(store, {
      concurrency: 1,
      pollInterval: 50,
      lockDuration: 5000,
      stalledInterval: 100,
    });
    worker.register("rescue-me", async () => {
      ran = true;
      return { rescued: true };
    });

    const startP = worker.start();
    const deadline = Date.now() + 5000;
    let completed = false;
    while (Date.now() < deadline) {
      const j = queue.getJob(id);
      if (j?.status === "completed") {
        completed = true;
        break;
      }
      await sleep(50);
    }

    worker.stop();
    await startP;

    expect(completed).toBe(true);
    expect(ran).toBe(true);
    const final = queue.getJob(id)!;
    expect(final.status).toBe("completed");
    expect(final.stalledCounter).toBeGreaterThanOrEqual(1);
    expect(final.result).toEqual({ rescued: true });
  }, 30000);
});

describe("E2E: deep tree fan-in", () => {
  it("grandchild completions propagate child_done up every level", async () => {
    const worker = new MinionWorker(store, {
      concurrency: 8,
      pollInterval: 50,
      lockDuration: 10000,
      stalledInterval: 60000,
    });

    worker.register("parent", async (ctx) => ({ kind: "parent", id: ctx.id }));
    worker.register("child", async (ctx) => ({ kind: "child", i: ctx.data.i }));
    worker.register("grandchild", async (ctx) => ({
      kind: "grandchild",
      i: ctx.data.i,
      j: ctx.data.j,
    }));

    const parent = queue.add("parent", {});
    const childIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const c = queue.add("child", { i }, { parentJobId: parent.id });
      childIds.push(c.id);
      for (let j = 0; j < 2; j++) {
        queue.add("grandchild", { i, j }, { parentJobId: c.id });
      }
    }

    const startP = worker.start();
    const deadline = Date.now() + 15000;
    let parentDone = false;
    while (Date.now() < deadline) {
      const j = queue.getJob(parent.id);
      if (j?.status === "completed") {
        parentDone = true;
        break;
      }
      await sleep(100);
    }

    worker.stop();
    await startP;

    expect(parentDone).toBe(true);

    const parentInbox = store.db
      .prepare(
        `SELECT payload FROM minion_inbox
         WHERE job_id = ? AND json_extract(payload, '$.type') = 'child_done'
         ORDER BY sent_at`,
      )
      .all(parent.id) as Array<{ payload: string }>;
    expect(parentInbox).toHaveLength(3);

    const allJobs = queue.getJobs({ limit: 100 });
    const completed = allJobs.filter((j) => j.status === "completed");
    expect(completed).toHaveLength(10);
  }, 30000);
});

describe("E2E: cascade kill under load", () => {
  it("cancelJob on parent cancels 10 active children", async () => {
    const worker = new MinionWorker(store, {
      concurrency: 12,
      pollInterval: 50,
      lockDuration: 300,
      stalledInterval: 60000,
    });

    const abortedChildren = new Set<number>();
    worker.register("slow-child", async (ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          abortedChildren.add(ctx.id);
          resolve();
          return;
        }
        const t = setTimeout(() => resolve(), 20000);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(t);
          abortedChildren.add(ctx.id);
          resolve();
        });
      });
      throw new Error("cancelled");
    });

    const parent = queue.add("parent-placeholder", {}, { maxChildren: 10 });
    for (let i = 0; i < 10; i++) {
      queue.add("slow-child", { i }, { parentJobId: parent.id });
    }

    const startP = worker.start();

    const claimDeadline = Date.now() + 5000;
    while (Date.now() < claimDeadline) {
      const active = queue.getJobs({ status: "active", limit: 100 });
      if (active.length === 10) {
        break;
      }
      await sleep(50);
    }

    queue.cancelJob(parent.id);

    const abortDeadline = Date.now() + 5000;
    while (Date.now() < abortDeadline) {
      if (abortedChildren.size >= 10) {
        break;
      }
      await sleep(50);
    }

    worker.stop();
    await startP;

    expect(abortedChildren.size).toBe(10);

    const parentJob = queue.getJob(parent.id)!;
    expect(parentJob.status).toBe("cancelled");

    const children = queue.getJobs({ name: "slow-child", limit: 100 });
    for (const child of children) {
      expect(child.status).toBe("cancelled");
    }
  }, 30000);
});
