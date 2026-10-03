import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawStateLeaseContext } from "../../state/openclaw-state-lease-context.js";
import { OpenClawStateLeaseError } from "../../state/openclaw-state-lease-error.js";
import type { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import { withWorktreeAllocationLease } from "./allocation.js";

const mocks = vi.hoisted(() => ({
  withLease: vi.fn<typeof withOpenClawStateLease>(),
}));

vi.mock("../../state/openclaw-state-lease.js", async () => ({
  OpenClawStateLeaseError: (await import("../../state/openclaw-state-lease-error.js"))
    .OpenClawStateLeaseError,
  withOpenClawStateLease: mocks.withLease,
}));

function lostLease() {
  return new OpenClawStateLeaseError("managed worktree allocation lease was lost", {
    code: "OPENCLAW_STATE_LEASE_LOST",
  });
}

describe("managed worktree allocation custody", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mocks.withLease.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a long preparation owned while a second creator waits through renewal contention", async () => {
    const pendingGit = createDeferred();
    const firstEntered = createDeferred();
    const contenders = new Map<string, Promise<void>>();
    const events: string[] = [];
    mocks.withLease.mockImplementation(async (options, run) => {
      const key = `${options.scope}/${options.key}`;
      const previous = contenders.get(key);
      const released = createDeferred();
      contenders.set(key, released.promise);
      await previous;
      const controller = new AbortController();
      let expiresAt = Date.now() + options.leaseMs;
      const assertOwned = () => {
        if (Date.now() >= expiresAt && !controller.signal.aborted) {
          controller.abort(lostLease());
        }
        controller.signal.throwIfAborted();
      };
      // Simulate a busy parent and a worker whose first renewal hits contention.
      // Only the selected independent owner can renew while the parent is occupied.
      const renewal =
        options.heartbeat === "worker"
          ? setInterval(() => {
              if (Date.now() < 40_000) {
                return;
              }
              try {
                assertOwned();
                expiresAt = Date.now() + options.leaseMs;
              } catch {
                // An expired grant cannot be revived by a delayed renewal.
              }
            }, options.leaseMs / 3)
          : undefined;
      try {
        const result = await run({
          signal: controller.signal,
          assertOwned,
          assertOwnedInTransaction: assertOwned,
        });
        assertOwned();
        return result;
      } finally {
        clearInterval(renewal);
        released.resolve();
      }
    });
    const first = withWorktreeAllocationLease({ env: {} }, async (guard) => {
      events.push("first started");
      firstEntered.resolve();
      await pendingGit.promise;
      guard.commitGuard();
      events.push("first published");
      return "first";
    });
    const firstResult = first.catch((error: unknown) => error);
    await firstEntered.promise;
    const second = withWorktreeAllocationLease({ env: {} }, async (guard) => {
      guard.commitGuard();
      events.push("second started");
      return "second";
    });
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(events).toEqual(["first started"]);
    pendingGit.resolve();
    await expect(firstResult).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first started", "first published", "second started"]);
  });

  it.each(["caller cancellation", "lease loss"] as const)(
    "fences publication after %s and retains rollback only for a current lease",
    async (ending) => {
      const pendingGit = createDeferred();
      const entered = createDeferred();
      const caller = new AbortController();
      const owner = new AbortController();
      const stopped = ending === "lease loss" ? lostLease() : new Error("session was canceled");
      const assertOwned = () => owner.signal.throwIfAborted();
      const lease: OpenClawStateLeaseContext = {
        signal: owner.signal,
        assertOwned,
        assertOwnedInTransaction: assertOwned,
      };
      mocks.withLease.mockImplementation(async (_options, run) => await run(lease));
      const published = vi.fn();
      const rolledBack = vi.fn();
      const operation = withWorktreeAllocationLease(
        { env: {}, signal: caller.signal },
        async (guard) => {
          entered.resolve();
          await pendingGit.promise;
          try {
            guard.commitGuard();
            published();
          } finally {
            guard.rollbackGuard();
            rolledBack();
          }
        },
      );
      const outcome = operation.catch((error: unknown) => error);
      await entered.promise;
      (ending === "lease loss" ? owner : caller).abort(stopped);
      pendingGit.resolve();
      await expect(outcome).resolves.toMatchObject({
        code:
          ending === "lease loss" ? "OPENCLAW_STATE_LEASE_LOST" : "OPENCLAW_STATE_LEASE_ABORTED",
      });
      expect(published).not.toHaveBeenCalled();
      expect(rolledBack).toHaveBeenCalledTimes(ending === "lease loss" ? 0 : 1);
    },
  );
});
