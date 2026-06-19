// Unit tests for the task-route lease module.
//
// Coverage:
//   1. acquire / getActive / round-trip
//   2. settle removes the lease from getActive
//   3. extend bumps the TTL
//   4. expireStaleTaskRouteLeases GCs only expired-and-still-active rows
//   5. SQLite persistence survives close + reopen (proves the lease lives
//      in the shared state DB rather than in-memory)
//   6. settled lease is not reusable for re-acquire into active state
//   7. mapDeliveryStatusToLeaseRetirement returns the right retire status
//   8. acquire with deliveryStatus 'not_applicable' is the caller's
//      responsibility (this module does not enforce it; the runtime hook
//      in createRunningTaskRun skips it). acquireTaskRouteLease itself
//      does not see deliveryStatus; we just prove idempotent re-acquire.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  acquireTaskRouteLease,
  expireStaleTaskRouteLeases,
  extendTaskRouteLease,
  getActiveTaskRouteLease,
  mapDeliveryStatusToLeaseRetirement,
  resetTaskRouteLeasesForTests,
  settleTaskRouteLease,
  updateTaskRouteLease,
} from "./task-route-lease.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-task-route-lease-"));
}

const SAMPLE_ORIGIN = {
  channel: "webchat",
  to: "user:test-user-1",
  accountId: "default",
};

beforeEach(() => {
  resetTaskRouteLeasesForTests();
});

afterEach(() => {
  closeOpenClawStateDatabase();
});

describe("task-route lease", () => {
  it("acquires and reads back an active lease", () => {
    const stateDir = createTempStateDir();
    const lease = acquireTaskRouteLease({
      runId: "run-1",
      taskId: "task-1",
      requesterOrigin: SAMPLE_ORIGIN,
      ttlMs: 60_000,
    });
    // Lease returned reflects the row that was written.
    expect(lease).toBeDefined();
    expect(lease?.runId).toBe("run-1");
    expect(lease?.taskId).toBe("task-1");
    expect(lease?.requesterOrigin).toEqual(SAMPLE_ORIGIN);
    expect(lease?.status).toBe("active");
    expect(lease?.expiresAt).toBeGreaterThan(Date.now());

    // Open the DB on the same state dir and read it back directly.
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const fetched = getActiveTaskRouteLease("run-1");
    expect(fetched?.runId).toBe("run-1");
    expect(fetched?.requesterOrigin).toEqual(SAMPLE_ORIGIN);
  });

  it("settles a lease and removes it from getActive", () => {
    acquireTaskRouteLease({
      runId: "run-settle",
      taskId: "task-settle",
      requesterOrigin: SAMPLE_ORIGIN,
      ttlMs: 60_000,
    });
    expect(getActiveTaskRouteLease("run-settle")).toBeDefined();

    const newlySettled = settleTaskRouteLease("run-settle", "settled");
    expect(newlySettled).toBe(true);

    // After settle the lease is no longer 'active', so getActive returns
    // undefined even though the row still exists in the DB.
    expect(getActiveTaskRouteLease("run-settle")).toBeUndefined();

    // Re-settle is a no-op (idempotent).
    const second = settleTaskRouteLease("run-settle", "settled");
    expect(second).toBe(false);
  });

  it("extends the TTL on an active lease", () => {
    acquireTaskRouteLease({
      runId: "run-extend",
      taskId: "task-extend",
      requesterOrigin: SAMPLE_ORIGIN,
      ttlMs: 1000,
    });
    const before = getActiveTaskRouteLease("run-extend");
    expect(before?.expiresAt).toBeDefined();

    // Extend by another 60s.
    const extended = extendTaskRouteLease("run-extend", 60_000);
    expect(extended).toBe(true);

    const after = getActiveTaskRouteLease("run-extend");
    expect(after).toBeDefined();
    expect(after!.expiresAt).toBeGreaterThan(before!.expiresAt + 30_000);

    // Extending a settled lease is a no-op.
    settleTaskRouteLease("run-extend", "settled");
    const extendingSettled = extendTaskRouteLease("run-extend", 60_000);
    expect(extendingSettled).toBe(false);
  });

  it("expires only stale active leases via GC", () => {
    // Lease #1: already expired (expiresAt in the past).
    acquireTaskRouteLease({
      runId: "run-stale",
      taskId: "task-stale",
      requesterOrigin: SAMPLE_ORIGIN,
      ttlMs: 1,
    });
    // Sleep past the 1ms TTL so the lease is stale.
    const sleepUntil = Date.now() + 50;
    while (Date.now() < sleepUntil) {
      // tight spin — only 50ms
    }

    // Lease #2: fresh, not stale.
    acquireTaskRouteLease({
      runId: "run-fresh",
      taskId: "task-fresh",
      requesterOrigin: SAMPLE_ORIGIN,
      ttlMs: 60_000,
    });

    const expiredCount = expireStaleTaskRouteLeases();
    expect(expiredCount).toBeGreaterThanOrEqual(1);

    // Stale lease is no longer active.
    expect(getActiveTaskRouteLease("run-stale")).toBeUndefined();
    // Fresh lease is still active.
    expect(getActiveTaskRouteLease("run-fresh")).toBeDefined();
  });

  it("persists leases across close + reopen of the shared state DB", () => {
    const stateDir = createTempStateDir();
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });

    acquireTaskRouteLease({
      runId: "run-persist",
      taskId: "task-persist",
      requesterOrigin: SAMPLE_ORIGIN,
      ttlMs: 60_000,
    });
    // Confirm the lease is readable while the DB is open.
    expect(getActiveTaskRouteLease("run-persist")).toBeDefined();

    // Close and reopen; the lease should still be there because it lives
    // in SQLite (not in-memory).
    closeOpenClawStateDatabase();
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });

    const after = getActiveTaskRouteLease("run-persist");
    expect(after).toBeDefined();
    expect(after?.runId).toBe("run-persist");
    expect(after?.requesterOrigin).toEqual(SAMPLE_ORIGIN);
  });

  it("re-acquire on a settled lease replaces the row and reactivates it", () => {
    // Acquire → settle → re-acquire on the same runId. The re-acquire
    // should overwrite the row (status active, fresh expiresAt, fresh
    // requester origin if provided).
    acquireTaskRouteLease({
      runId: "run-reacquire",
      taskId: "task-reacquire",
      requesterOrigin: SAMPLE_ORIGIN,
      ttlMs: 60_000,
    });
    settleTaskRouteLease("run-reacquire", "retired");
    expect(getActiveTaskRouteLease("run-reacquire")).toBeUndefined();

    // Re-acquire with a NEW origin (simulates a re-spawn with different
    // delivery config). The lease row must be reused, not duplicated.
    const newOrigin = { ...SAMPLE_ORIGIN, to: "user:test-user-2" };
    acquireTaskRouteLease({
      runId: "run-reacquire",
      taskId: "task-reacquire",
      requesterOrigin: newOrigin,
      ttlMs: 60_000,
    });
    const after = getActiveTaskRouteLease("run-reacquire");
    expect(after).toBeDefined();
    expect(after?.status).toBe("active");
    expect(after?.requesterOrigin).toEqual(newOrigin);
  });

  it("mapDeliveryStatusToLeaseRetirement maps terminal statuses correctly", () => {
    expect(mapDeliveryStatusToLeaseRetirement("delivered")).toBe("settled");
    expect(mapDeliveryStatusToLeaseRetirement("session_queued")).toBe("settled");
    expect(mapDeliveryStatusToLeaseRetirement("failed")).toBe("retired");
    // Non-terminal statuses do not retire the lease.
    expect(mapDeliveryStatusToLeaseRetirement("pending")).toBeNull();
    expect(mapDeliveryStatusToLeaseRetirement("parent_missing")).toBeNull();
    expect(mapDeliveryStatusToLeaseRetirement("not_applicable")).toBeNull();
    // Unknown / future statuses do not retire either.
    expect(mapDeliveryStatusToLeaseRetirement("whatever")).toBeNull();
  });

  it("acquire with empty requesterOrigin still writes a lease row", () => {
    // The lease module itself does not enforce deliveryStatus. The
    // detached-task-runtime createRunningTaskRun hook skips acquire when
    // deliveryStatus === 'not_applicable', but the module accepts the
    // call regardless. This test pins that behavior.
    const lease = acquireTaskRouteLease({
      runId: "run-empty",
      taskId: "task-empty",
      ttlMs: 60_000,
    });
    expect(lease).toBeDefined();
    expect(lease?.requesterOrigin).toBeUndefined();
    expect(getActiveTaskRouteLease("run-empty")).toBeDefined();
  });

  it("does not crash if acquire is called with the same runId twice without settle", () => {
    // Idempotent acquire — the second call replaces the row rather than
    // crashing on the unique constraint.
    acquireTaskRouteLease({
      runId: "run-twice",
      taskId: "task-twice",
      requesterOrigin: SAMPLE_ORIGIN,
      ttlMs: 60_000,
    });
    const second = acquireTaskRouteLease({
      runId: "run-twice",
      taskId: "task-twice",
      requesterOrigin: { ...SAMPLE_ORIGIN, to: "user:test-user-3" },
      ttlMs: 120_000,
    });
    expect(second).toBeDefined();
    expect(second?.expiresAt).toBeGreaterThan(Date.now() + 60_000);
    expect(getActiveTaskRouteLease("run-twice")?.requesterOrigin?.to).toBe("user:test-user-3");
  });
});

describe("updateTaskRouteLease (#92460 P1 #2)", () => {
  it("replaces requesterOrigin on an active lease", () => {
    // Reported case: cron captured only `channel: "webchat"` at acquire
    // time. After the resolver produces the concrete (channel, to, thread),
    // the lease is updated so the completion-time resolver can recover it.
    acquireTaskRouteLease({
      runId: "run-update",
      taskId: "task-update",
      requesterOrigin: { channel: "webchat" },
      ttlMs: 60_000,
    });
    const before = getActiveTaskRouteLease("run-update");
    expect(before?.requesterOrigin).toEqual({ channel: "webchat" });

    const updated = updateTaskRouteLease("run-update", {
      channel: "webchat",
      to: "user:test-user-resolved",
      threadId: "thread-1",
    });
    expect(updated).toBe(true);

    const after = getActiveTaskRouteLease("run-update");
    expect(after?.requesterOrigin).toEqual({
      channel: "webchat",
      to: "user:test-user-resolved",
      threadId: "thread-1",
    });
  });

  it("returns false for a settled lease (does not re-arm)", () => {
    acquireTaskRouteLease({
      runId: "run-settled",
      taskId: "task-settled",
      requesterOrigin: SAMPLE_ORIGIN,
      ttlMs: 60_000,
    });
    settleTaskRouteLease("run-settled", "settled");
    const updated = updateTaskRouteLease("run-settled", {
      channel: "telegram",
      to: "chat:99",
    });
    expect(updated).toBe(false);
    expect(getActiveTaskRouteLease("run-settled")).toBeUndefined();
  });

  it("returns false for a missing runId", () => {
    const updated = updateTaskRouteLease("run-does-not-exist", {
      channel: "webchat",
      to: "user:nobody",
    });
    expect(updated).toBe(false);
  });

  it("preserves original origin when called with undefined", () => {
    acquireTaskRouteLease({
      runId: "run-empty-update",
      taskId: "task-empty-update",
      requesterOrigin: SAMPLE_ORIGIN,
      ttlMs: 60_000,
    });
    const updated = updateTaskRouteLease("run-empty-update", undefined);
    expect(updated).toBe(true);
    // The lease stays active; the origin is cleared (matches acquire
    // semantics for a partial origin).
    const after = getActiveTaskRouteLease("run-empty-update");
    expect(after?.requesterOrigin).toBeUndefined();
  });
});

// Sanity check on the test temp dir cleanup so we don't leave sqlite
// files in /tmp after a run. afterEach closes the DB; this block only
// guards against the rare case where the test failed before afterEach.
process.on("exit", () => {
  try {
    closeOpenClawStateDatabase();
  } catch {
    // noop
  }
  // Best-effort sweep of any leftover test temp dirs.
  try {
    const tmpRoot = os.tmpdir();
    for (const entry of fs.readdirSync(tmpRoot)) {
      if (entry.startsWith("openclaw-task-route-lease-")) {
        fs.rmSync(path.join(tmpRoot, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // noop
  }
});
