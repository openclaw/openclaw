import { expect, it } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createSessionRowPlacementProjection } from "./session-row-placement-projection.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";

function placementSnapshot(reconciling: readonly string[]): WorkerSessionPlacementProjection {
  return {
    placements: new Map(),
    moves: new Map(),
    environments: new Map(),
    workspaceResultReconcilingSessionIds: new Set(reconciling),
  };
}

it("refreshes placement facts invalidated after the read settles but before consumption", async () => {
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
  const reading = owner.withPrepared(
    () => [sessionId],
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
    ).toBe(true);
    expect(consumed).toEqual([true]);
  } finally {
    owner.dispose();
    releaseFacts.resolve();
    await settled;
  }
});

it("settles queued placement preparation on disposal without dispatching it", async () => {
  const firstEntered = createDeferredCore();
  const secondEntered = createDeferredCore();
  const queuedSelected = createDeferredCore();
  const releaseFirst = createDeferredCore();
  const releaseSecond = createDeferredCore();
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
    const first = owner.withPrepared(
      () => ["first"],
      () => consume("first"),
    );
    active.push(Promise.allSettled([first]));
    await withTestTimeout(firstEntered.promise, 2_000, "First placement read did not enter");
    const second = owner.withPrepared(
      () => ["second"],
      () => consume("second"),
    );
    active.push(Promise.allSettled([second]));
    await withTestTimeout(secondEntered.promise, 2_000, "Second placement read did not enter");
    const queued = owner.withPrepared(
      () => {
        queuedSelected.resolve();
        return ["queued"];
      },
      () => consume("queued"),
    );
    const queuedOutcome = Promise.allSettled([queued]);
    await withTestTimeout(queuedSelected.promise, 2_000, "Third placement demand was not admitted");
    expect(dispatched).toEqual([["first"], ["second"]]);
    owner.dispose();
    expect(
      await withTestTimeout(
        queuedOutcome,
        2_000,
        "Disposed queued preparation waited for active reads to settle",
      ),
    ).toEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({ message: "Session row projection is no longer active" }),
      },
    ]);
  } finally {
    owner.dispose();
    releaseFirst.resolve();
    releaseSecond.resolve();
    await withTestTimeout(Promise.all(active), 2_000, "Accepted placement reads did not settle");
  }
  expect(dispatched).toEqual([["first"], ["second"]]);
  expect(consumed).toEqual([]);
});
