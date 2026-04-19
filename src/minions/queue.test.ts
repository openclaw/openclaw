import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MinionQueue } from "./queue.js";
import { MinionStore } from "./store.js";

let tmpDir: string;
let dbPath: string;
let store: MinionStore;
let queue: MinionQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "minions-queue-"));
  dbPath = path.join(tmpDir, "queue.sqlite");
  store = MinionStore.openAt(dbPath);
  queue = new MinionQueue(store);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MinionQueue.add", () => {
  it("creates a waiting job with defaults", () => {
    const job = queue.add("echo", { msg: "hello" });
    expect(job.id).toBeGreaterThan(0);
    expect(job.name).toBe("echo");
    expect(job.status).toBe("waiting");
    expect(job.queue).toBe("default");
    expect(job.priority).toBe(0);
    expect(job.data).toEqual({ msg: "hello" });
    expect(job.maxAttempts).toBe(3);
    expect(job.backoffType).toBe("exponential");
    expect(job.depth).toBe(0);
    expect(job.createdAt).toBeGreaterThan(0);
  });

  it("rejects empty name", () => {
    expect(() => queue.add("")).toThrow("Job name cannot be empty");
    expect(() => queue.add("   ")).toThrow("Job name cannot be empty");
  });

  it("creates a delayed job", () => {
    const job = queue.add("delayed", {}, { delay: 5000 });
    expect(job.status).toBe("delayed");
    expect(job.delayUntil).toBeGreaterThan(Date.now() - 1000);
  });

  it("dedupes on idempotency_key", () => {
    const a = queue.add("x", { v: 1 }, { idempotencyKey: "same" });
    const b = queue.add("x", { v: 2 }, { idempotencyKey: "same" });
    expect(a.id).toBe(b.id);
    expect(b.data).toEqual({ v: 1 });
  });

  it("allows multiple null idempotency_key jobs", () => {
    const a = queue.add("x", { v: 1 });
    const b = queue.add("x", { v: 2 });
    expect(a.id).not.toBe(b.id);
  });
});

describe("parent/child", () => {
  it("creates child with incremented depth", () => {
    const parent = queue.add("parent");
    const child = queue.add("child", {}, { parentJobId: parent.id });
    expect(child.depth).toBe(1);
    expect(child.parentJobId).toBe(parent.id);

    const updatedParent = queue.getJob(parent.id)!;
    expect(updatedParent.status).toBe("waiting-children");
  });

  it("enforces maxSpawnDepth", () => {
    const q = new MinionQueue(store, { maxSpawnDepth: 2 });
    const p = q.add("root");
    const c1 = q.add("c1", {}, { parentJobId: p.id });
    const c2 = q.add("c2", {}, { parentJobId: c1.id });
    expect(c2.depth).toBe(2);
    expect(() => q.add("c3", {}, { parentJobId: c2.id })).toThrow(
      /spawn depth 3 exceeds maxSpawnDepth 2/,
    );
  });

  it("enforces maxChildren", () => {
    const parent = queue.add("parent", {}, { maxChildren: 2 });
    queue.add("c1", {}, { parentJobId: parent.id });
    queue.add("c2", {}, { parentJobId: parent.id });
    expect(() => queue.add("c3", {}, { parentJobId: parent.id })).toThrow(
      /already has 2 live children/,
    );
  });

  it("rejects missing parent_job_id", () => {
    expect(() => queue.add("child", {}, { parentJobId: 99999 })).toThrow(
      /parent_job_id 99999 not found/,
    );
  });
});

describe("claim", () => {
  it("claims a waiting job and sets it active", () => {
    queue.add("echo");
    const claimed = queue.claim("tok-1", 30000, "default", ["echo"]);
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("active");
    expect(claimed!.lockToken).toBe("tok-1");
    expect(claimed!.lockUntil).toBeGreaterThan(Date.now());
    expect(claimed!.attemptsStarted).toBe(1);
  });

  it("returns null on empty queue", () => {
    expect(queue.claim("tok", 30000, "default", ["echo"])).toBeNull();
  });

  it("returns null if no matching names", () => {
    queue.add("echo");
    expect(queue.claim("tok", 30000, "default", ["nope"])).toBeNull();
  });

  it("claims by priority DESC then created_at ASC", () => {
    queue.add("low", {}, { priority: 1 });
    queue.add("high", {}, { priority: 10 });
    queue.add("med", {}, { priority: 5 });

    const first = queue.claim("t1", 30000, "default", ["low", "high", "med"]);
    expect(first!.name).toBe("high");

    const second = queue.claim("t2", 30000, "default", ["low", "high", "med"]);
    expect(second!.name).toBe("med");
  });

  it("does not claim non-waiting statuses (attached, paused, etc.)", () => {
    const job = queue.add("echo");
    queue.pauseJob(job.id);
    expect(queue.claim("tok", 30000, "default", ["echo"])).toBeNull();
  });

  it("EXPLAIN QUERY PLAN hits the claim index", () => {
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM minion_jobs
         WHERE queue = ? AND status = 'waiting' AND name IN (?)
         ORDER BY priority DESC, created_at ASC, id ASC
         LIMIT 1`,
      )
      .all("default", "echo") as Array<{ detail: string }>;
    const details = plan.map((r) => r.detail).join(" ");
    expect(details).toMatch(/idx_minion_jobs_claim/i);
  });
});

describe("completeJob", () => {
  it("transitions active to completed with result", () => {
    queue.add("echo");
    const claimed = queue.claim("tok", 30000, "default", ["echo"])!;
    const done = queue.completeJob(claimed.id, "tok", claimed.attemptsMade, { ok: true });
    expect(done).not.toBeNull();
    expect(done!.status).toBe("completed");
    expect(done!.result).toEqual({ ok: true });
    expect(done!.finishedAt).toBeGreaterThan(0);
  });

  it("CAS guard rejects stale attempts_made", () => {
    queue.add("echo");
    const claimed = queue.claim("tok", 30000, "default", ["echo"])!;
    const result = queue.completeJob(claimed.id, "tok", claimed.attemptsMade + 999, {});
    expect(result).toBeNull();
  });

  it("rolls up tokens to parent", () => {
    const parent = queue.add("parent");
    queue.add("child", {}, { parentJobId: parent.id });
    const claimed = queue.claim("tok", 30000, "default", ["child"])!;
    queue.updateTokens(claimed.id, "tok", { input: 100, output: 50, cacheRead: 25 });
    queue.completeJob(claimed.id, "tok", claimed.attemptsMade, {});

    const updated = queue.getJob(parent.id)!;
    expect(updated.tokensInput).toBe(100);
    expect(updated.tokensOutput).toBe(50);
    expect(updated.tokensCacheRead).toBe(25);
  });

  it("resolves parent when all children complete", () => {
    const parent = queue.add("parent");
    queue.add("c1", {}, { parentJobId: parent.id });
    queue.add("c2", {}, { parentJobId: parent.id });

    const claimed1 = queue.claim("t1", 30000, "default", ["c1"])!;
    queue.completeJob(claimed1.id, "t1", claimed1.attemptsMade, {});
    expect(queue.getJob(parent.id)!.status).toBe("waiting-children");

    const claimed2 = queue.claim("t2", 30000, "default", ["c2"])!;
    queue.completeJob(claimed2.id, "t2", claimed2.attemptsMade, {});
    expect(queue.getJob(parent.id)!.status).toBe("waiting");
  });
});

describe("failJob", () => {
  it("transitions to delayed for retry", () => {
    queue.add("echo", {}, { maxAttempts: 3 });
    const claimed = queue.claim("tok", 30000, "default", ["echo"])!;
    const failed = queue.failJob(claimed.id, "tok", claimed.attemptsMade, "boom", "delayed", 1000);
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("delayed");
    expect(failed!.delayUntil).toBeGreaterThan(Date.now());
    expect(failed!.stacktrace).toContain("boom");
  });

  it("fail_parent policy cascades failure to parent", () => {
    const parent = queue.add("parent");
    queue.add("child", {}, { parentJobId: parent.id, onChildFail: "fail_parent" });
    const claimed = queue.claim("tok", 30000, "default", ["child"])!;
    queue.failJob(claimed.id, "tok", claimed.attemptsMade, "child-error", "failed");
    expect(queue.getJob(parent.id)!.status).toBe("failed");
  });

  it("CAS guard rejects stale attempts_made", () => {
    queue.add("echo");
    const claimed = queue.claim("tok", 30000, "default", ["echo"])!;
    const result = queue.failJob(claimed.id, "tok", claimed.attemptsMade + 999, "x", "failed");
    expect(result).toBeNull();
  });
});

describe("cancelJob (cascade)", () => {
  it("cancels a single job", () => {
    const job = queue.add("echo");
    const cancelled = queue.cancelJob(job.id);
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("cancelled");
  });

  it("cascade-cancels descendants", () => {
    const root = queue.add("root");
    const c1 = queue.add("c1", {}, { parentJobId: root.id });
    const c2 = queue.add("c2", {}, { parentJobId: c1.id });
    const c3 = queue.add("c3", {}, { parentJobId: c2.id });

    queue.cancelJob(root.id);

    expect(queue.getJob(c1.id)!.status).toBe("cancelled");
    expect(queue.getJob(c2.id)!.status).toBe("cancelled");
    expect(queue.getJob(c3.id)!.status).toBe("cancelled");
  });

  it("does not cancel already-terminal jobs in the subtree", () => {
    const root = queue.add("root");
    const c1 = queue.add("c1", {}, { parentJobId: root.id });
    const claimed = queue.claim("tok", 30000, "default", ["c1"])!;
    queue.completeJob(claimed.id, "tok", claimed.attemptsMade, {});

    queue.cancelJob(root.id);
    expect(queue.getJob(c1.id)!.status).toBe("completed");
  });
});

describe("handleStalled", () => {
  it("requeues jobs with expired locks below max_stalled", () => {
    queue.add("echo");
    const claimed = queue.claim("tok", 1, "default", ["echo"])!;
    store.db
      .prepare("UPDATE minion_jobs SET lock_until = ?, max_stalled = ? WHERE id = ?")
      .run(Date.now() - 10000, 3, claimed.id);

    const { requeued, dead } = queue.handleStalled();
    expect(requeued).toHaveLength(1);
    expect(requeued[0].status).toBe("waiting");
    expect(dead).toHaveLength(0);
  });

  it("dead-letters jobs at max_stalled", () => {
    queue.add("echo", {}, { maxAttempts: 1 });
    const claimed = queue.claim("tok", 1, "default", ["echo"])!;
    store.db
      .prepare("UPDATE minion_jobs SET lock_until = ?, stalled_counter = ? WHERE id = ?")
      .run(Date.now() - 10000, 1, claimed.id);

    const { requeued, dead } = queue.handleStalled();
    expect(requeued).toHaveLength(0);
    expect(dead).toHaveLength(1);
    expect(dead[0].status).toBe("dead");
  });
});

describe("handleTimeouts", () => {
  it("dead-letters jobs past timeout_at", () => {
    queue.add("echo", {}, { timeoutMs: 1 });
    const claimed = queue.claim("tok", 60000, "default", ["echo"])!;
    store.db
      .prepare("UPDATE minion_jobs SET timeout_at = ? WHERE id = ?")
      .run(Date.now() - 10000, claimed.id);

    const timed = queue.handleTimeouts();
    expect(timed).toHaveLength(1);
    expect(timed[0].status).toBe("dead");
    expect(timed[0].errorText).toBe("timeout exceeded");
  });
});

describe("promoteDelayed", () => {
  it("promotes delayed jobs past delay_until", () => {
    queue.add("echo", {}, { delay: 1 });
    store.db
      .prepare("UPDATE minion_jobs SET delay_until = ? WHERE status = 'delayed'")
      .run(Date.now() - 10000);

    const promoted = queue.promoteDelayed();
    expect(promoted).toHaveLength(1);
    expect(promoted[0].status).toBe("waiting");
  });
});

describe("prune", () => {
  it("removes old terminal jobs", () => {
    queue.add("echo");
    const claimed = queue.claim("tok", 30000, "default", ["echo"])!;
    queue.completeJob(claimed.id, "tok", claimed.attemptsMade, {});
    store.db
      .prepare("UPDATE minion_jobs SET updated_at = ? WHERE id = ?")
      .run(Date.now() - 31 * 86400000, claimed.id);

    const count = queue.prune();
    expect(count).toBe(1);
  });
});

describe("inbox", () => {
  it("sends and reads inbox messages", () => {
    queue.add("echo");
    const claimed = queue.claim("tok", 30000, "default", ["echo"])!;

    queue.sendMessage(claimed.id, { instruction: "stop" }, "admin");
    const messages = queue.readInbox(claimed.id, "tok");
    expect(messages).toHaveLength(1);
    expect(messages[0].payload).toEqual({ instruction: "stop" });
    expect(messages[0].readAt).toBeGreaterThan(0);
  });
});

describe("stats", () => {
  it("returns status counts", () => {
    queue.add("a");
    queue.add("b");
    queue.add("c");
    queue.claim("tok", 30000, "default", ["a"]);

    const stats = queue.getStats();
    expect(stats.byStatus.waiting).toBe(2);
    expect(stats.byStatus.active).toBe(1);
  });
});

describe("lock management", () => {
  it("renewLock extends lock_until", () => {
    queue.add("echo");
    const claimed = queue.claim("tok", 5000, "default", ["echo"])!;
    const renewed = queue.renewLock(claimed.id, "tok", 60000);
    expect(renewed).toBe(true);

    const job = queue.getJob(claimed.id)!;
    expect(job.lockUntil! - Date.now()).toBeGreaterThan(50000);
  });

  it("renewLock fails with wrong token", () => {
    queue.add("echo");
    const claimed = queue.claim("tok", 5000, "default", ["echo"])!;
    expect(queue.renewLock(claimed.id, "wrong-tok", 60000)).toBe(false);
  });
});

describe("handler_pid", () => {
  it("sets and clears handler_pid", () => {
    queue.add("echo");
    const claimed = queue.claim("tok", 30000, "default", ["echo"])!;
    expect(queue.setHandlerPid(claimed.id, "tok", 12345)).toBe(true);
    expect(queue.getJob(claimed.id)!.handlerPid).toBe(12345);

    queue.clearHandlerPid(claimed.id);
    expect(queue.getJob(claimed.id)!.handlerPid).toBeNull();
  });
});
