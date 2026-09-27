import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  ACTIVE_PLACEMENT,
  admittedRecovery,
  createCoordinatorTestService,
  LOCAL_PLACEMENT,
  MOVE_REQUEST,
  PROVISIONING_PLACEMENT,
  REQUEST,
} from "./placement-dispatch-coordinator.test-support.js";

it.each(["full sweep", "targeted sweep", "recovery"] as const)(
  "reclaims an independent session before %s waiting for an unrelated dispatch",
  async (maintenance) => {
    const dispatchEntered = createDeferredCore();
    const dispatchRelease = createDeferredCore();
    const reclaimRelease = createDeferredCore();
    const events: string[] = [];
    const stopped = {
      sessionId: "stopped-session",
      sessionKey: "agent:main:stopped-session",
      agentId: "main",
    };
    const service = createCoordinatorTestService({
      dispatch: async (request) => {
        events.push(`dispatch:${request.sessionId}`);
        if (request.sessionId === REQUEST.sessionId) {
          dispatchEntered.resolve();
          await dispatchRelease.promise;
        }
        return { ...ACTIVE_PLACEMENT, ...request };
      },
      reconcile: async () => {
        events.push("maintenance");
      },
      reconcileActive: async () => {
        events.push("maintenance");
      },
      resumeProvisioning: admittedRecovery(async (_placement, core) => {
        events.push("maintenance");
        await core();
      }),
      reclaim: async (request, _authorize, _beforeDrain, serialize, pending) => {
        await pending?.settled;
        if (!serialize) {
          throw new Error("Reclaim fixture requires serialization");
        }
        return await serialize(async () => {
          events.push(`reclaim:${request.sessionId}`);
          if (request.sessionId === stopped.sessionId) {
            await reclaimRelease.promise;
          }
          return { ...LOCAL_PLACEMENT, ...request };
        });
      },
    });
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
    const dispatch = coordinated.dispatch(REQUEST);
    await dispatchEntered.promise;
    const pendingMaintenance =
      maintenance === "full sweep"
        ? coordinated.reconcile()
        : maintenance === "targeted sweep"
          ? coordinated.reconcileActive("worker-other")
          : coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {});
    const firstStop = coordinated.reclaim(stopped);
    const secondStop = coordinated.reclaim({
      ...stopped,
      sessionId: "another-stopped-session",
      sessionKey: "agent:main:another-stopped-session",
    });
    let laterDispatch: Promise<unknown> | undefined;
    let laterStop: Promise<unknown> | undefined;
    try {
      await setImmediatePromise();
      expect([...events]).toEqual([
        `dispatch:${REQUEST.sessionId}`,
        `reclaim:${stopped.sessionId}`,
      ]);
      dispatchRelease.resolve();
      await dispatch;
      await setImmediatePromise();
      // Maintenance and the later Stop cannot overtake the first Stop's effects.
      expect([...events]).toEqual([
        `dispatch:${REQUEST.sessionId}`,
        `reclaim:${stopped.sessionId}`,
      ]);
      laterStop = coordinated.reclaim({
        ...stopped,
        sessionId: "late-stopped-session",
        sessionKey: "agent:main:late-stopped-session",
      });
      laterDispatch = coordinated.dispatch({
        ...REQUEST,
        sessionId: "later-session",
        sessionKey: "agent:main:later-session",
      });
      reclaimRelease.resolve();
    } finally {
      dispatchRelease.resolve();
      reclaimRelease.resolve();
      await Promise.all([
        dispatch,
        pendingMaintenance,
        firstStop,
        secondStop,
        laterStop,
        laterDispatch,
      ]);
    }
    expect(events).toEqual([
      `dispatch:${REQUEST.sessionId}`,
      `reclaim:${stopped.sessionId}`,
      "reclaim:another-stopped-session",
      "maintenance",
      "reclaim:late-stopped-session",
      "dispatch:later-session",
    ]);
  },
);

it.each([false, true])(
  "joined provisioning recovery waits for an admitted reclaim to settle (reclaim fails=%s)",
  async (reclaimFails) => {
    const dispatchEntered = createDeferredCore();
    const dispatchRelease = createDeferredCore();
    const reclaimRelease = createDeferredCore();
    const events: string[] = [];
    const failure = new Error("provider cleanup pending");
    const service = createCoordinatorTestService({
      dispatch: async () => {
        dispatchEntered.resolve();
        await dispatchRelease.promise;
        return ACTIVE_PLACEMENT;
      },
      reconcile: async () => {
        events.push("sweep");
      },
      reclaim: async (_request, _authorize, _beforeDrain, serialize) => {
        if (!serialize) {
          throw new Error("Reclaim fixture requires serialization");
        }
        return await serialize(async () => {
          events.push("reclaim:start");
          await reclaimRelease.promise;
          events.push("reclaim:finish");
          if (reclaimFails) {
            throw failure;
          }
          return LOCAL_PLACEMENT;
        });
      },
      resumeProvisioning: admittedRecovery(async (_placement, core) => {
        events.push("recovery");
        await core();
      }),
    });
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
    const dispatch = coordinated.dispatch({
      ...REQUEST,
      sessionId: "other-dispatch",
      sessionKey: "agent:main:other-dispatch",
    });
    await dispatchEntered.promise;
    const sweep = coordinated.reconcile();
    const reclaim = coordinated.reclaim(REQUEST).catch((error: unknown) => error);
    const recovery = coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {});
    try {
      await setImmediatePromise();
      expect([...events]).toEqual(["reclaim:start"]);
      dispatchRelease.resolve();
      await dispatch;
      await setImmediatePromise();
      expect([...events]).toEqual(["reclaim:start"]);
    } finally {
      dispatchRelease.resolve();
      reclaimRelease.resolve();
      await Promise.all([dispatch, sweep, reclaim, recovery]);
    }
    if (reclaimFails) {
      expect(await reclaim).toBe(failure);
    }
    expect(events.slice(0, 2)).toEqual(["reclaim:start", "reclaim:finish"]);
    expect(events.slice(2).toSorted()).toEqual(["recovery", "sweep"]);
  },
);

it("preserves a queued move ahead of reclaim even when maintenance has not started", async () => {
  const dispatchEntered = createDeferredCore();
  const dispatchRelease = createDeferredCore();
  const exclusiveEntered = createDeferredCore();
  const exclusiveRelease = createDeferredCore();
  const events: string[] = [];
  const runExclusive = async () => {
    events.push("exclusive:start");
    exclusiveEntered.resolve();
    await exclusiveRelease.promise;
    events.push("exclusive:finish");
    return LOCAL_PLACEMENT;
  };
  const service = createCoordinatorTestService({
    dispatch: async () => {
      dispatchEntered.resolve();
      await dispatchRelease.promise;
      return ACTIVE_PLACEMENT;
    },
    reconcile: async () => {
      events.push("sweep");
    },
    move: runExclusive,
    reclaim: async (_request, _authorize, _beforeDrain, serialize) => {
      if (!serialize) {
        throw new Error("Reclaim fixture requires serialization");
      }
      return await serialize(async () => {
        events.push("reclaim");
        return LOCAL_PLACEMENT;
      });
    },
  });
  const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
  const dispatch = coordinated.dispatch(REQUEST);
  await dispatchEntered.promise;
  const sweep = coordinated.reconcile();
  const previous = coordinated.move(MOVE_REQUEST);
  // Move reserves its fence after session admission.
  await setImmediatePromise();
  const reclaim = coordinated.reclaim({
    ...REQUEST,
    sessionId: "other-session",
    sessionKey: "agent:main:other-session",
  });
  try {
    await setImmediatePromise();
    expect([...events]).toEqual([]);
    dispatchRelease.resolve();
    await exclusiveEntered.promise;
    await setImmediatePromise();
    expect([...events]).toEqual(["sweep", "exclusive:start"]);
  } finally {
    dispatchRelease.resolve();
    exclusiveRelease.resolve();
    await Promise.all([dispatch, sweep, previous, reclaim]);
  }
  expect(events).toEqual(["sweep", "exclusive:start", "exclusive:finish", "reclaim"]);
});

it.each(["sweep", "recovery"] as const)(
  "preserves admitted %s effects before a later reclaim",
  async (maintenance) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const events: string[] = [];
    const maintain = async () => {
      events.push("maintenance:start");
      entered.resolve();
      await release.promise;
      events.push("maintenance:finish");
    };
    const service = createCoordinatorTestService({
      reconcile: maintain,
      resumeProvisioning: admittedRecovery(maintain),
      reclaim: async (_request, _authorize, _beforeDrain, serialize) => {
        if (!serialize) {
          throw new Error("Reclaim fixture requires serialization");
        }
        return await serialize(async () => {
          events.push("reclaim");
          return LOCAL_PLACEMENT;
        });
      },
    });
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
    const maintaining =
      maintenance === "sweep"
        ? coordinated.reconcile()
        : coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {});
    await entered.promise;
    const stopping = coordinated.reclaim(REQUEST);
    try {
      await setImmediatePromise();
      expect([...events]).toEqual(["maintenance:start"]);
    } finally {
      release.resolve();
      await Promise.all([maintaining, stopping]);
    }
    expect(events).toEqual(["maintenance:start", "maintenance:finish", "reclaim"]);
  },
);
