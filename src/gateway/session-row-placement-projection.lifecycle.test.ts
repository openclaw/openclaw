import { expect, it } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createSessionRowPlacementProjection } from "./session-row-placement-projection.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { create as createSessionRow, type Lookup } from "./session-row-projection-record.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";

function placementReadView() {
  const projection: SessionRowReadView & { isCurrent(): boolean } = {
    state: {
      cfg: {},
      policyConfig: {},
      rowContext: buildSessionListRowMetadataContext({ now: 1 }),
    },
    describe: () => undefined,
    readSource: () => undefined,
    selectEntries: () => [],
    present: () => {
      throw new Error("Placement lifecycle does not present session rows");
    },
    isCurrent: () => true,
  };
  const query = (id: string): Lookup => ({ agentId: "main", key: id });
  const lookup = (target: Lookup) => {
    const entry = { sessionId: target.key, updatedAt: 1 };
    return {
      ...createSessionRow({ ...target, storeTarget: { agentId: "main", storePath: "" } }, entry),
      entry,
    };
  };
  return { projection, query, lookup };
}

function placementSnapshot(reconciling: readonly string[]): WorkerSessionPlacementProjection {
  return {
    placements: new Map(),
    moves: new Map(),
    environments: new Map(),
    workspaceResultReconcilingSessionIds: new Set(reconciling),
  };
}

it("refreshes placement facts invalidated after the read settles but before consumption", async () => {
  const { projection, query, lookup } = placementReadView();
  const sessionId = "completed-placement-read";
  const factsEntered = createDeferredCore();
  const releaseFacts = createDeferredCore();
  let firstRead = true;
  let factsPending = false;
  let reconciling = false;
  const owner = createSessionRowPlacementProjection(
    {
      async readProjection(ids) {
        const snapshot = placementSnapshot(reconciling ? ids : []);
        if (firstRead) {
          firstRead = false;
          factsPending = true;
        }
        return snapshot;
      },
    },
    () => {
      if (!factsPending) {
        return undefined;
      }
      factsPending = false;
      factsEntered.resolve();
      return releaseFacts.promise;
    },
  );
  const consumed: Array<boolean | undefined> = [];
  const reading = owner.withPreparedRows(
    projection,
    () => true,
    lookup,
    () => [query(sessionId)],
    () => undefined,
    () => {
      const value = owner.getProjectionFacts(sessionId)?.workspaceResultReconciling;
      consumed.push(value);
      return value;
    },
  );
  const settled = Promise.allSettled([reading]);
  try {
    await withTestTimeout(factsEntered.promise, 2_000, "Post-read facts preparation did not enter");
    expect(consumed).toEqual([]);
    reconciling = true;
    owner.invalidate(sessionId);
    releaseFacts.resolve();
    expect(
      await withTestTimeout(reading, 2_000, "Invalidated placement facts did not refresh"),
    ).toEqual({ kind: "complete", value: true });
    expect(consumed).toEqual([true]);
  } finally {
    owner.dispose();
    releaseFacts.resolve();
    await settled;
  }
});

it("settles queued placement preparation on disposal without dispatching it", async () => {
  const { projection, query, lookup } = placementReadView();
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
    const first = owner.withPreparedRows(
      projection,
      () => true,
      lookup,
      () => [query("first")],
      () => undefined,
      () => consume("first"),
    );
    active.push(Promise.allSettled([first]));
    await withTestTimeout(firstEntered.promise, 2_000, "First placement read did not enter");
    const second = owner.withPreparedRows(
      projection,
      () => true,
      lookup,
      () => [query("second")],
      () => undefined,
      () => consume("second"),
    );
    active.push(Promise.allSettled([second]));
    await withTestTimeout(secondEntered.promise, 2_000, "Second placement read did not enter");
    const queued = queuedIds.map((id) =>
      owner.withPreparedRows(
        projection,
        () => true,
        lookup,
        () => {
          if (++selectedCount === queuedIds.length) {
            queuedSelected.resolve();
          }
          return [query(id)];
        },
        () => undefined,
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
  const { projection, query, lookup } = placementReadView();
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
    const result = owner.withPreparedRows(
      projection,
      () => true,
      lookup,
      () => [query(id)],
      () => undefined,
      () => owner.getProjectionFacts(id)?.workspaceResultReconciling,
    );
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
    await expect(olderRead).resolves.toEqual({ kind: "complete", value: true });
    await preparing;
    await expect(newerRead).resolves.toEqual({ kind: "complete", value: true });
  } finally {
    owner.dispose();
    for (const step of steps) {
      step.release.resolve();
    }
    await Promise.all(accepted);
  }
});
