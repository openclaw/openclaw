import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withTestTimeout } from "../../test/helpers/promise.js";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { createMainThreadStallMonitor, runWithMainThreadTask } from "../infra/main-thread-stall.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createSessionRowPlacementProjection } from "./session-row-placement-projection.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { create as createSessionRow, type Lookup } from "./session-row-projection-record.js";
import * as sessionStoreKeys from "./session-store-key.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";

function placementReadView() {
  const projection: SessionRowReadView & {
    isCurrent(): boolean;
    getPolicyConfig(): SessionRowReadView["state"]["policyConfig"];
  } = {
    physicalPaths: (locator) => [locator],
    state: {
      cfg: {},
      policyConfig: {},
      rowContext: buildSessionListRowMetadataContext({ now: 1 }),
    },
    describe: () => undefined,
    readSource: () => undefined,
    readMembership: () => undefined,
    selectEntries: () => [],
    present: () => {
      throw new Error("Placement lifecycle does not present session rows");
    },
    isCurrent: () => true,
    getPolicyConfig: () => projection.state.policyConfig,
  };
  const query = (id: string): Lookup => ({ agentId: "main", key: id });
  const lookup = (target: Lookup) => {
    const entry = { sessionId: target.key, updatedAt: 1 };
    return {
      ...createSessionRow({ ...target, storeTarget: { agentId: "main", storePath: "" } }, entry),
      entry,
    };
  };
  const read = <T>(
    owner: ReturnType<typeof createSessionRowPlacementProjection>,
    select: string | (() => Lookup[]),
    consume: () => T,
    prepareRows: () => undefined | Promise<void> = () => undefined,
  ) =>
    owner.withPreparedRows(
      projection,
      () => true,
      lookup,
      typeof select === "string" ? () => [query(select)] : select,
      prepareRows,
      consume,
    );
  return { projection, query, read };
}

function placementSnapshot(reconciling: readonly string[]): WorkerSessionPlacementProjection {
  return {
    placements: new Map(),
    moves: new Map(),
    pendingResults: new Map(),
    workspaceJournalOwnerSessionIds: new Set(),
    environments: new Map(),
    workspaceResultReconcilingSessionIds: new Set(reconciling),
    workspaceRecoveryPendingSessionIds: new Set(),
  };
}

it.each(["gateway:rpc:sessions.list", "scheduler:maintenance:session-refresh"])(
  "attributes prepared-row work after readiness waits without relabeling roster consumers: %s",
  async (task) => {
    const { read, query } = placementReadView();
    let now = 0;
    const monitor = createMainThreadStallMonitor(() => now);
    let ready = false;
    const owner = createSessionRowPlacementProjection(undefined, () => {
      if (ready) {
        return undefined;
      }
      return Promise.resolve().then(() => {
        now += 5_000;
        ready = true;
      });
    });
    try {
      await runWithMainThreadTask(task, async () => {
        await Promise.resolve();
        await read(
          owner,
          () => {
            now += 300;
            return [query("synthetic")];
          },
          () => {
            now += 400;
            withAgentRosterFactsBatch({}, () => {
              now += 500;
            });
          },
          () => {
            now += 350;
            return undefined;
          },
        );
      });
      expect(monitor.drain().stalls).toEqual([
        {
          elapsedMs: 300,
          task: `${task}:session-rows:select`,
          taskMs: 300,
          startedAt: 5_000,
          endedAt: 5_300,
        },
        {
          elapsedMs: 350,
          task: `${task}:session-rows:prepare`,
          taskMs: 350,
          startedAt: 5_300,
          endedAt: 5_650,
        },
        {
          elapsedMs: 900,
          task: `${task}:session-rows:consume`,
          taskMs: 900,
          startedAt: 5_650,
          endedAt: 6_550,
        },
      ]);
    } finally {
      owner.dispose();
      monitor.stop();
    }
  },
);

it.each([false, true])(
  "settles native results before later topology changes (placement reader: %s)",
  async (withPlacement) => {
    const { projection, read } = placementReadView();
    const preparedState = projection.state;
    let topologyChanged = false;
    let consumed = 0;
    let preparedKeyReads = 0;
    const keyReads = vi.spyOn(sessionStoreKeys, "resolveStoredSessionKeyForAgentStore");
    Object.defineProperty(projection, "state", {
      get() {
        if (topologyChanged) {
          throw new Error("Session row topology changed; prepare current facts before reading");
        }
        return preparedState;
      },
    });
    const owner = createSessionRowPlacementProjection(
      withPlacement ? { readProjection: async () => placementSnapshot([]) } : undefined,
      () => undefined,
    );
    try {
      const reading = read(
        owner,
        "completed-native-read",
        () => {
          // Durable selection already classified these keys before entering the read view.
          expect(keyReads).toHaveBeenCalledTimes(preparedKeyReads);
          consumed++;
          queueMicrotask(() => {
            topologyChanged = true;
          });
          return "prepared";
        },
        () => {
          preparedKeyReads = keyReads.mock.calls.length;
          return undefined;
        },
      );
      await expect(reading).resolves.toEqual("prepared");
      expect(consumed).toBe(1);
    } finally {
      keyReads.mockRestore();
      owner.dispose();
    }
  },
);

it.each(["facts", "rows"] as const)(
  "releases exact preparation after the requesting observation closes during %s readiness",
  async (phase) => {
    const { read } = placementReadView();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const work = new AsyncWorkScope();
    const cancelled = new Error("Requesting connection closed");
    let preparations = 0;
    let consumed = false;
    const prepare = () => {
      preparations++;
      if (preparations === 1) {
        entered.resolve();
        return release.promise;
      }
      return undefined;
    };
    const owner = createSessionRowPlacementProjection(
      undefined,
      phase === "facts" ? prepare : () => undefined,
    );
    const reading = work.track(() =>
      read(
        owner,
        "cancelled-exact-read",
        () => {
          consumed = true;
        },
        phase === "rows" ? prepare : () => undefined,
      ),
    );
    const settled = Promise.allSettled([reading]);
    try {
      await awaitGateBeforeSettlement(entered.promise, reading, "Read did not enter preparation");
      work.beginClose(cancelled);
      release.resolve();
      await expect(reading).rejects.toBe(cancelled);
      expect(preparations).toBe(1);
      expect(consumed).toBe(false);
    } finally {
      release.resolve();
      owner.dispose();
      await settled;
      await work.drain();
    }
  },
);

it("settles queued placement preparation on disposal without dispatching it", async () => {
  const { query, read } = placementReadView();
  const firstEntered = createDeferredCore();
  const secondEntered = createDeferredCore();
  const queuedSelected = createDeferredCore();
  const releaseFirst = createDeferredCore();
  const releaseSecond = createDeferredCore();
  const queuedIds = Array.from(
    { length: 3 },
    (_, index) => `queued-${index}-${"x".repeat(12 * 1024)}`,
  );
  let selectedCount = 0;
  const dispatched: string[][] = [];
  const consumed: Array<boolean | undefined> = [];
  const owner = createSessionRowPlacementProjection(
    {
      async readProjection(ids) {
        dispatched.push([...ids]);
        if (ids.includes("first")) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        if (ids.includes("second")) {
          secondEntered.resolve();
          await releaseSecond.promise;
        }
        return placementSnapshot(ids);
      },
    },
    () => undefined,
  );
  const active: Promise<unknown>[] = [];
  const consume = (id: string) => {
    const value = owner.getProjectionFacts(id)?.workspaceResultReconciling;
    consumed.push(value);
    return value;
  };
  try {
    const first = read(owner, "first", () => consume("first"));
    active.push(Promise.allSettled([first]));
    await withTestTimeout(firstEntered.promise, 2_000, "First placement read did not enter");
    const second = read(owner, "second", () => consume("second"));
    active.push(Promise.allSettled([second]));
    await withTestTimeout(secondEntered.promise, 2_000, "Second placement read did not enter");
    const queued = queuedIds.map((id) =>
      read(
        owner,
        () => {
          if (++selectedCount === queuedIds.length) {
            queuedSelected.resolve();
          }
          return [query(id)];
        },
        () => consume(id),
      ),
    );
    const queuedOutcome = Promise.allSettled(queued);
    active.push(queuedOutcome);
    await withTestTimeout(
      queuedSelected.promise,
      2_000,
      "Queued placement demand was not selected",
    );
    expect(dispatched).toEqual([["first"], ["second"]]);
    owner.dispose();
    expect(
      await withTestTimeout(
        queuedOutcome,
        2_000,
        "Disposed queued preparation waited for active reads to settle",
      ),
    ).toEqual(
      queuedIds.map(() => ({
        status: "rejected",
        reason: expect.objectContaining({ message: "Session row projection is no longer active" }),
      })),
    );
  } finally {
    owner.dispose();
    releaseFirst.resolve();
    releaseSecond.resolve();
    await withTestTimeout(Promise.all(active), 2_000, "Accepted placement reads did not settle");
  }
  expect(dispatched).toEqual([["first"], ["second"]]);
  expect(consumed).toEqual([]);
});

it("keeps resident preparation ahead of later exact demand in the accepted FIFO", async () => {
  const { read } = placementReadView();
  const createStep = (id: string) => ({
    id,
    entered: createDeferredCore(),
    release: createDeferredCore(),
  });
  const first = createStep("first");
  const second = createStep("second");
  const older = createStep("older");
  const resident = createStep("resident");
  const newer = createStep("newer");
  const steps = [first, second, older, resident, newer];
  const dispatched: string[][] = [];
  const owner = createSessionRowPlacementProjection(
    {
      async readProjection(ids) {
        dispatched.push([...ids]);
        for (const step of steps) {
          if (ids.includes(step.id)) {
            step.entered.resolve();
            await step.release.promise;
          }
        }
        return placementSnapshot(ids);
      },
    },
    () => undefined,
  );
  const accepted: Promise<unknown>[] = [];
  const exact = (id: string) => {
    const result = read(owner, id, () => owner.getProjectionFacts(id)?.workspaceResultReconciling);
    accepted.push(Promise.allSettled([result]));
    return result;
  };
  try {
    void exact(first.id);
    await withTestTimeout(first.entered.promise, 2_000, "First read did not enter");
    void exact(second.id);
    await withTestTimeout(second.entered.promise, 2_000, "Second read did not enter");
    const olderRead = exact(older.id);
    owner.register(resident.id);
    const preparing = owner.prepare();
    accepted.push(Promise.allSettled([preparing]));
    const newerRead = exact(newer.id);
    first.release.resolve();
    await withTestTimeout(older.entered.promise, 2_000, "Older queued read did not enter");
    expect(dispatched).toEqual([["first"], ["second"], ["older"]]);
    older.release.resolve();
    await withTestTimeout(resident.entered.promise, 2_000, "Resident preparation did not enter");
    expect(dispatched).toEqual([["first"], ["second"], ["older"], ["resident"]]);
    resident.release.resolve();
    await withTestTimeout(newer.entered.promise, 2_000, "Newer queued read did not enter");
    expect(dispatched).toEqual([["first"], ["second"], ["older"], ["resident"], ["newer"]]);
    newer.release.resolve();
    await expect(olderRead).resolves.toEqual(true);
    await preparing;
    await expect(newerRead).resolves.toEqual(true);
  } finally {
    owner.dispose();
    for (const step of steps) {
      step.release.resolve();
    }
    await Promise.all(accepted);
  }
});
