import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import { createNodeWorkerSupervisor, mocks } from "./node-worker-supervisor.mock.test-support.js";
import { fixture, recoveryFixture } from "./node-worker-supervisor.settlement.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";

afterEach(() => vi.resetAllMocks());

it("joins accepted workspace retention before sealing journals on close", async () => {
  const entered = createDeferred();
  const release = createDeferred<{ applied: boolean; deleted: number; hasMore: boolean }>();
  mocks.launchList.mockResolvedValue([]);
  mocks.launchCount.mockResolvedValue(0);
  mocks.launchPrune.mockResolvedValue(0);
  mocks.drain.mockResolvedValue(undefined);
  mocks.retain.mockImplementation(async () => {
    entered.resolve();
    return await release.promise;
  });
  const supervisor = createNodeWorkerSupervisor({
    env: { OPENCLAW_STATE_DIR: "/synthetic/state" },
  });
  const input = {
    version: 1 as const,
    gatewayNamespace: "gateway-1",
    controllerId: "controller-1",
    sequence: 1,
    retain: [],
  };
  const retained = supervisor.retainWorkspaces(input);
  await entered.promise;
  let closed = false;
  const closing = supervisor.close().then(() => {
    closed = true;
  });
  try {
    await nextTurn();
    expect(closed).toBe(false);
    expect(mocks.drain).not.toHaveBeenCalled();
    expect(await supervisor.hasActiveWork()).toBe(true);
    await expect(supervisor.retainWorkspaces(input)).rejects.toThrow("supervisor is closed");
    release.resolve({ applied: true, deleted: 0, hasMore: false });
    await Promise.all([retained, closing]);
    expect(closed).toBe(true);
    expect(await supervisor.hasActiveWork()).toBe(false);
  } finally {
    release.resolve({ applied: true, deleted: 0, hasMore: false });
    await Promise.allSettled([retained, closing]);
  }
});

it.each(["cancelled", "caller-abort", "cleanup-failure"] as const)(
  "joins pending admission cancellation through %s settlement",
  async (outcome) => {
    const input = testWorkerLaunchInput("/synthetic/workspace", "pending-cancel");
    const identity = testNodeWorkerLaunchIdentity(input);
    const entered = createDeferred();
    const releaseClaim = createDeferred();
    const finishing = createDeferred();
    const releaseFinish = createDeferred();
    const controller = new AbortController();
    const callerAbort = new Error("Caller revoked admission");
    const cleanupFailure = new Error("Physical reservation cleanup failed");
    const snapshots: number[] = [];
    let receipt: NodeWorkerLaunchReceipt | undefined;
    mocks.launchList.mockResolvedValue([]);
    mocks.launchPrune.mockResolvedValue(0);
    mocks.launchCount.mockImplementation(async () => (receipt?.state === "pending" ? 1 : 0));
    mocks.turnGet.mockResolvedValue(undefined);
    mocks.turnMatching.mockResolvedValue(undefined);
    mocks.launchClaim.mockImplementation(async (claim, supervisor) => {
      receipt = {
        ...claim,
        supervisor,
        worker: null,
        workerCleanupMode: null,
        workerLineageSettled: false,
        state: "pending",
        resultJson: null,
        errorText: null,
        completedAtMs: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      };
      return { action: "start", receipt, nonterminalCount: 1 };
    });
    mocks.turnClaim.mockImplementation(async (_claim, authority) => {
      entered.resolve();
      await releaseClaim.promise;
      authority?.assertCurrent();
      throw new Error("Cancelled admission unexpectedly retained authority");
    });
    mocks.launchFinish.mockImplementation(async (params) => {
      const current = receipt;
      if (!current) {
        throw new Error("Physical reservation was never admitted");
      }
      finishing.resolve();
      await releaseFinish.promise;
      if (outcome === "cleanup-failure") {
        throw cleanupFailure;
      }
      receipt = { ...current, state: params.state };
      return receipt;
    });
    const supervisor = createNodeWorkerSupervisor({
      env: { OPENCLAW_STATE_DIR: "/synthetic/state" },
      capacity: 1,
      capacityWaitMs: 0,
      onCapacityChanged: (snapshot) => snapshots.push(snapshot.available),
    });
    const launching = supervisor.launch(input, TEST_WORKER_ENDPOINT, controller.signal);
    const launchResult = launching.catch((error: unknown) => error);
    let cancelling: Promise<unknown> | undefined;
    let cancellationSettled = false;
    try {
      await entered.promise;
      if (outcome === "caller-abort") {
        controller.abort(callerAbort);
      }
      cancelling = supervisor.cancel(identity).then(
        (value) => {
          cancellationSettled = true;
          return value;
        },
        (error: unknown) => {
          cancellationSettled = true;
          throw error;
        },
      );
      const cancelResult = cancelling.catch((error: unknown) => error);
      await nextTurn();
      expect(cancellationSettled).toBe(false);
      releaseClaim.resolve();
      await finishing.promise;
      await nextTurn();
      expect(cancellationSettled).toBe(false);
      expect(snapshots.at(-1)).toBe(0);
      expect(mocks.prepare).not.toHaveBeenCalled();
      releaseFinish.resolve();
      if (outcome === "cleanup-failure") {
        expect(await cancelResult).toBe(cleanupFailure);
        expect(await launchResult).toBe(cleanupFailure);
        expect(snapshots.at(-1)).toBe(0);
        expect(await supervisor.hasActiveWork()).toBe(true);
      } else {
        expect(await cancelResult).toBeUndefined();
        expect(await launchResult).toBeInstanceOf(Error);
        expect(receipt?.state).toBe("cancelled");
        expect(snapshots.at(-1)).toBe(1);
        expect(await supervisor.hasActiveWork()).toBe(false);
      }
    } finally {
      releaseClaim.resolve();
      releaseFinish.resolve();
      await Promise.allSettled([launching, cancelling]);
      await supervisor.close();
    }
  },
);

it("settles retained startup cancellation without joining its own admission", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    f.emitResult.resolve();
    await f.entered.promise;
    f.persistence.resolve();
    await nextTurn();
    expect(await f.supervisor.status(f.identity.launchId)).toMatchObject({ state: "completed" });
    f.firstRemoval.resolve();
    f.retryRemoval.resolve();
    mocks.send.mockImplementation(async (_adapter, message) => {
      if (message.type === "turn") {
        controller.abort(new Error("Caller cancelled during retained dispatch"));
      } else {
        throw new Error("Synthetic child input is closed");
      }
    });
    const input = testWorkerLaunchInput("/synthetic/workspace", "retained-start-cancel");
    expect(await f.supervisor.launch(input, TEST_WORKER_ENDPOINT, controller.signal)).toMatchObject(
      {
        launchId: input.launchId,
        state: "cancelled",
      },
    );
    expect(f.snapshots.at(-1)).toBe(1);
    expect(await f.supervisor.hasActiveWork()).toBe(false);
  } finally {
    await f.dispose();
  }
});

describe("node worker persistence settlement lifetime", () => {
  it("follows journal admission into live turn settlement without waiting for the status deadline", async () => {
    vi.useFakeTimers();
    const admitted = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    const f = await fixture(false, { entered: () => admitted.resolve(), ready: release.promise });
    const observed: NodeWorkerLaunchReceipt[] = [];
    let waiting: Promise<unknown> | undefined;
    try {
      await admitted.promise;
      waiting = f.supervisor
        .status(f.identity.launchId, { waitMs: 20_000, signal: controller.signal })
        .then((receipt) => {
          if (receipt) {
            observed.push(receipt);
          }
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(observed).toEqual([]);
      release.resolve();
      await f.launching;
      f.emitResult.resolve();
      await f.entered.promise;
      f.persistence.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(observed).toEqual([expect.objectContaining({ state: "completed" })]);
      await waiting;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      release.resolve();
      await Promise.allSettled([waiting, f.launching]);
      await f.dispose();
      vi.useRealTimers();
    }
  });

  it("wakes status waiters only after the exact turn is journaled, independently of its retained child", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      const observed: NodeWorkerLaunchReceipt[] = [];
      const waiting = f.supervisor
        .status(f.identity.launchId, { waitMs: 20_000 })
        .then((receipt) => {
          if (receipt) {
            observed.push(receipt);
          }
          return receipt;
        });
      await vi.advanceTimersByTimeAsync(0);
      f.emitResult.resolve();
      await f.entered.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(observed).toEqual([]);
      f.persistence.resolve();
      await expect(waiting).resolves.toMatchObject({ state: "completed" });
      expect(vi.getTimerCount()).toBe(0);
      expect(f.snapshots.at(-1)).toBe(0);
      expect(await f.supervisor.hasActiveWork()).toBe(true);
      await expect(f.supervisor.status(f.identity.launchId, { waitMs: 20_000 })).resolves.toEqual(
        observed[0],
      );
      await expect(
        f.supervisor.status("unknown-turn", { waitMs: 20_000 }),
      ).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["timeout", "disconnect"] as const)(
    "releases a status waiter on %s without cancelling the turn",
    async (reason) => {
      vi.useFakeTimers();
      const f = await fixture();
      const controller = new AbortController();
      try {
        const waiting = f.supervisor.status(f.identity.launchId, {
          waitMs: 100,
          signal: controller.signal,
        });
        await vi.advanceTimersByTimeAsync(0);
        if (reason === "timeout") {
          await vi.advanceTimersByTimeAsync(100);
          await expect(waiting).resolves.toMatchObject({ state: "running" });
        } else {
          const rejected = expect(waiting).rejects.toThrow("Operation aborted");
          controller.abort();
          await rejected;
        }
        expect(vi.getTimerCount()).toBe(0);
        expect(mocks.turnFinish).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
        expect(f.snapshots.at(-1)).toBe(0);
      } finally {
        await f.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(["ownership read", "terminal admission"] as const)(
    "retains the stale launch when recovery closes during %s",
    async (boundary) => {
      const f = recoveryFixture(true);
      const entered = createDeferred();
      const release = createDeferred();
      if (boundary === "ownership read") {
        mocks.launchMatching.mockResolvedValueOnce(f.original).mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return f.original;
        });
      } else {
        mocks.launchFinish.mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          return f.finish(...args);
        });
      }
      const recovering = f.recover(f.original, true, undefined, true);
      try {
        await entered.promise;
        f.close();
        release.resolve();
        expect(await recovering).toEqual(f.original);
        expect(await f.store.nonterminalCount()).toBe(1);
        if (boundary === "ownership read") {
          expect(mocks.remove).not.toHaveBeenCalled();
          expect(mocks.launchFinish).not.toHaveBeenCalled();
        }
      } finally {
        f.close();
        release.resolve();
        await recovering;
      }
    },
  );

  it.each(["before admission", "after admission", "unknown settlement"] as const)(
    "preserves recovery cancellation and terminal authority %s",
    async (boundary) => {
      const f = recoveryFixture();
      const entered = createDeferred();
      const release = createDeferred();
      const unknown = new SqliteWorkerError(
        "Synthetic transaction outcome is unknown",
        "outcome-unknown",
      );
      mocks.launchFinish.mockImplementationOnce(async (...args) => {
        const committed = boundary === "after admission" ? await f.finish(...args) : undefined;
        entered.resolve();
        await release.promise;
        if (boundary === "unknown settlement") {
          throw unknown;
        }
        return committed ?? f.finish(...args);
      });
      const recovering = f.recover(f.original, true, undefined, true);
      let cancellation: Promise<NodeWorkerLaunchReceipt> | undefined;
      try {
        await entered.promise;
        cancellation = f.recover(f.original, true, "cancelled", true);
        const settled = Promise.allSettled([recovering, cancellation]);
        release.resolve();
        if (boundary === "unknown settlement") {
          expect(await settled).toEqual([
            { status: "rejected", reason: unknown },
            { status: "rejected", reason: unknown },
          ]);
          expect(mocks.launchFinish).toHaveBeenCalledOnce();
          expect(await f.store.nonterminalCount()).toBe(1);
        } else {
          const state = boundary === "before admission" ? "cancelled" : "interrupted";
          expect(await settled).toEqual([
            { status: "fulfilled", value: expect.objectContaining({ state }) },
            { status: "fulfilled", value: expect.objectContaining({ state }) },
          ]);
          expect(mocks.launchFinish).toHaveBeenCalledTimes(boundary === "before admission" ? 2 : 1);
          expect(await f.store.nonterminalCount()).toBe(0);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([recovering, cancellation]);
      }
    },
  );

  it("keeps receipt replay available after close without admitting a new launch", async () => {
    const f = await fixture();
    try {
      f.emitResult.resolve();
      await f.entered.promise;
      f.persistence.resolve();
      await nextTurn();
      const completed = await f.supervisor.status(f.identity.launchId);
      await f.dispose();
      const writes = mocks.turnFinish.mock.calls.length + mocks.launchFinish.mock.calls.length;
      expect(await f.supervisor.status(f.identity.launchId)).toEqual(completed);
      expect(await f.supervisor.cancel(f.identity)).toEqual(completed);
      await expect(
        f.supervisor.launch(
          testWorkerLaunchInput("/synthetic/workspace", "after-close-turn"),
          TEST_WORKER_ENDPOINT,
        ),
      ).rejects.toThrow("supervisor is closed");
      expect(mocks.turnFinish.mock.calls.length + mocks.launchFinish.mock.calls.length).toBe(
        writes,
      );
    } finally {
      await f.dispose();
    }
  });

  it("does not initialize recovery for a receipt read after closing an unused supervisor", async () => {
    const supervisor = createNodeWorkerSupervisor({
      env: { OPENCLAW_STATE_DIR: "/synthetic/state" },
    });
    mocks.launchList.mockRejectedValue(new Error("Recovery must stay closed"));
    mocks.turnGet.mockResolvedValue(undefined);
    await supervisor.close();
    expect(await supervisor.status("absent-turn")).toBeUndefined();
    expect(mocks.launchList).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("retries failed close cleanup before completing shutdown", async () => {
    const f = await fixture();
    const failure = new Error("Synthetic close cleanup failed");
    try {
      f.emitResult.resolve();
      await f.entered.promise;
      f.persistence.resolve();
      await nextTurn();
      const closing = f.supervisor.close();
      const rejected = expect(closing).rejects.toBe(failure);
      await f.removalEntered.promise;
      f.firstRemoval.reject(failure);
      await rejected;
      expect(f.snapshots.at(-1)).toBe(0);
      f.retryRemoval.resolve();
      await f.supervisor.close();
      expect(f.snapshots.at(-1)).toBe(1);
      expect(await f.supervisor.cancel(f.identity)).toMatchObject({ state: "completed" });
    } finally {
      await f.dispose();
    }
  });

  it("reconciles an observed replacement after a delayed running receipt", async () => {
    const f = await fixture();
    const readEntered = createDeferred();
    const releaseRead = createDeferred();
    try {
      mocks.launchFinish.mockRejectedValueOnce(new Error("Synthetic terminal journal failure"));
      mocks.turnMatching.mockImplementationOnce(async () => {
        const receipt = f.readReceipt();
        readEntered.resolve();
        await releaseRead.promise;
        return receipt;
      });
      const cancellation = f.supervisor.cancel(f.identity);
      await readEntered.promise;
      f.emitResult.resolve();
      await f.entered.promise;
      f.persistence.reject(new Error("Synthetic result journal failure"));
      f.firstRemoval.resolve();
      f.retryRemoval.resolve();
      await nextTurn();
      expect(f.turnSettled()).toBe(false);
      releaseRead.resolve();
      expect(await cancellation).toMatchObject({ state: "cancelled" });
      expect(f.turnSettled()).toBe(true);
      expect(f.snapshots.at(-1)).toBe(1);
    } finally {
      releaseRead.resolve();
      await f.dispose();
    }
  });

  it("retains turn completion after physical cleanup until terminal persistence succeeds", async () => {
    const f = await fixture();
    const failure = new Error("Synthetic terminal journal failure");
    try {
      mocks.launchFinish.mockRejectedValueOnce(failure);
      f.emitResult.resolve();
      await f.entered.promise;
      f.persistence.reject(new Error("Synthetic result journal failure"));
      f.firstRemoval.resolve();
      f.retryRemoval.resolve();
      await nextTurn();
      expect(mocks.launchFinish).toHaveBeenCalledOnce();
      expect(f.turnSettled()).toBe(false);
      expect(f.snapshots.at(-1)).toBe(0);
      mocks.launchFinish.mockRejectedValueOnce(failure);
      await expect(f.supervisor.cancel(f.identity)).rejects.toBe(failure);
      expect(f.turnSettled()).toBe(false);
      expect(await f.supervisor.status(f.identity.launchId)).toMatchObject({ state: "failed" });
      expect(f.turnSettled()).toBe(true);
      expect(f.snapshots.at(-1)).toBe(1);
    } finally {
      await f.dispose();
    }
  });

  it.each([
    { timing: "during persistence", expectedState: "cancelled" },
    { timing: "after failed cleanup", expectedState: "failed" },
  ] as const)(
    "retries owned container cleanup when cancellation starts $timing",
    async ({ timing, expectedState }) => {
      const f = await fixture();
      const cleanupFailure = new Error("Synthetic container cleanup failed");
      let cancellation: Promise<NodeWorkerLaunchReceipt | undefined> | undefined;
      try {
        f.emitResult.resolve();
        await f.entered.promise;
        if (timing === "during persistence") {
          cancellation = f.supervisor.cancel(f.identity);
          void cancellation.catch(() => undefined);
          await nextTurn();
        }
        f.persistence.reject(new Error("Synthetic known write failure"));
        await f.removalEntered.promise;
        await nextTurn();
        if (timing === "during persistence") {
          expect(mocks.send).toHaveBeenCalledOnce();
        }
        f.firstRemoval.reject(cleanupFailure);
        await nextTurn();
        if (cancellation) {
          await expect(cancellation).rejects.toBe(cleanupFailure);
        }
        expect(f.readTurn()?.state).toBe("running");
        expect(f.turnSettled()).toBe(false);
        expect(mocks.launchFinish).not.toHaveBeenCalled();
        expect(f.snapshots.at(-1)).toBe(0);
        const retry = f.supervisor.cancel(f.identity);
        await nextTurn();
        expect(mocks.remove).toHaveBeenCalledTimes(2);
        expect(mocks.launchFinish).not.toHaveBeenCalled();
        f.retryRemoval.resolve();
        expect(await retry).toMatchObject({ state: expectedState });
        expect(mocks.launchFinish.mock.lastCall?.[0].state).toBe(expectedState);
        expect(f.turnSettled()).toBe(true);
        expect(f.snapshots.at(-1)).toBe(1);
      } finally {
        await f.dispose();
      }
    },
  );

  it("lets successful persistence win over a reentrant cancellation", async () => {
    const f = await fixture();
    let cancellation: Promise<NodeWorkerLaunchReceipt | undefined> | undefined;
    try {
      f.onPersist.call = () => {
        cancellation = f.supervisor.cancel(f.identity);
      };
      f.emitResult.resolve();
      await f.entered.promise;
      await nextTurn();
      expect(cancellation).toBeDefined();
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
      f.persistence.resolve();
      expect(await cancellation).toMatchObject({ state: "completed" });
      expect(f.turnSettled()).toBe(true);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(f.snapshots.at(-1)).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  it("retains unknown-outcome refusal after rejected persistence", async () => {
    const f = await fixture(true);
    const failure = new SqliteWorkerError(
      "Synthetic transaction outcome is unknown",
      "outcome-unknown",
    );
    try {
      f.emitResult.resolve();
      await f.entered.promise;
      const cancellation = f.supervisor.cancel(f.identity);
      let cancelled = false;
      void cancellation.then(
        () => {
          cancelled = true;
        },
        () => {
          cancelled = true;
        },
      );
      await nextTurn();
      f.persistence.reject(failure);
      await f.removalEntered.promise;
      f.firstRemoval.reject(new Error("Synthetic container cleanup failed"));
      await nextTurn();
      expect(cancelled).toBe(true);
      await expect(cancellation).rejects.toBe(failure);
      expect(f.readTurn()?.state).toBe("running");
      expect(f.turnSettled()).toBe(false);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.launchFinish).not.toHaveBeenCalled();
      expect(f.snapshots.at(-1)).toBe(0);
      f.retryRemoval.resolve();
      await expect(f.supervisor.close()).rejects.toThrow();
      await expect(f.supervisor.status(f.identity.launchId)).rejects.toBe(failure);
    } finally {
      await f.dispose();
    }
  });

  it.each(["before settlement", "during settlement"] as const)(
    "retains completion ownership across a delayed receipt read starting %s",
    async (timing) => {
      const f = await fixture();
      const readEntered = createDeferred();
      const releaseRead = createDeferred();
      try {
        if (timing === "during settlement") {
          f.emitResult.resolve();
          await f.entered.promise;
        }
        mocks.turnMatching.mockImplementationOnce(async () => {
          const receipt = f.readReceipt();
          readEntered.resolve();
          await releaseRead.promise;
          return receipt;
        });
        const cancellation = f.supervisor.cancel(f.identity);
        if (timing === "before settlement") {
          await readEntered.promise;
          f.emitResult.resolve();
          await f.entered.promise;
        }
        f.persistence.resolve();
        await readEntered.promise;
        await nextTurn();
        releaseRead.resolve();
        await nextTurn();
        expect(mocks.remove).not.toHaveBeenCalled();
        expect(await cancellation).toMatchObject({
          state: timing === "before settlement" ? "cancelled" : "completed",
        });
        expect(mocks.send).not.toHaveBeenCalled();
      } finally {
        releaseRead.resolve();
        await f.dispose();
      }
    },
  );
});
