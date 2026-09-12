import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
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
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";

describe("worker placement maintenance admission", () => {
  it.each(["ready", "provider-pending", "abort", "stop", "move", "replacement"] as const)(
    "retains restarted input between provider passes until %s",
    async (outcome) => {
      const firstPass = createDeferredCore();
      const providerSettled = createDeferredCore();
      const controller = new AbortController();
      const active = {
        ...ACTIVE_PLACEMENT,
        sessionId: PROVISIONING_PLACEMENT.sessionId,
        generation: PROVISIONING_PLACEMENT.generation + 1,
      };
      let attempts = 0;
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          resumeProvisioning: async (placement, core, report, admit) => {
            report?.(placement);
            return await admit!(async (signal) => {
              await core(signal);
              if (++attempts === 1) {
                return undefined;
              }
              report?.(active);
              return active;
            });
          },
        }),
        (_request, run) => run(),
        async (placement) => {
          await coordinated.resumeProvisioning(placement, async (_signal, retain) => {
            if (outcome === "provider-pending") {
              retain?.(providerSettled.promise);
            }
          });
          firstPass.resolve();
        },
      );
      let held = true;
      const waiting = coordinated.waitForInitialPlacement(
        PROVISIONING_PLACEMENT,
        controller.signal,
      );
      void waiting.then(
        () => (held = false),
        () => (held = false),
      );
      try {
        await firstPass.promise;
        await setImmediatePromise();
        expect(held).toBe(true);
        expect(coordinated.isPlacementOperationInFlight(PROVISIONING_PLACEMENT.sessionId)).toBe(
          outcome === "provider-pending",
        );
        if (outcome === "provider-pending") {
          // A timed-out provider still owns admission after its foreground pass ended.
          await coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {});
          await setImmediatePromise();
          expect(held).toBe(true);
          expect(attempts).toBe(1);
          providerSettled.resolve();
          await setImmediatePromise();
        }
        if (outcome === "abort") {
          controller.abort(new Error("input cancelled"));
        } else if (outcome === "stop") {
          await coordinated.reclaim(PROVISIONING_PLACEMENT).catch(() => undefined);
        } else if (outcome === "move") {
          await coordinated
            .move({ ...MOVE_REQUEST, sessionId: PROVISIONING_PLACEMENT.sessionId })
            .catch(() => undefined);
        } else {
          await coordinated.resumeProvisioning(
            {
              ...PROVISIONING_PLACEMENT,
              generation: PROVISIONING_PLACEMENT.generation + (outcome === "replacement" ? 1 : 0),
            },
            async () => {},
          );
        }
        if (outcome === "ready" || outcome === "provider-pending") {
          await expect(waiting).resolves.toEqual(active);
        } else {
          await expect(waiting).rejects.toThrow();
        }
      } finally {
        providerSettled.resolve();
        controller.abort();
        await waiting.catch(() => undefined);
      }
    },
  );

  it("reports failure to start guarded recovery and honors already-cancelled input", async () => {
    const recover = vi.fn(async () => {
      throw new Error("gateway is stopping");
    });
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({}),
      (_request, run) => run(),
      recover,
    );
    await expect(coordinated.waitForInitialPlacement(PROVISIONING_PLACEMENT)).rejects.toThrow(
      "gateway is stopping",
    );
    await expect(
      coordinated.waitForInitialPlacement(PROVISIONING_PLACEMENT, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(recover).toHaveBeenCalledOnce();
  });

  it.each(["active", "incomplete", "stale-generation"] as const)(
    "holds input for its exact recovery owner (%s)",
    async (outcome) => {
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      const active = {
        ...ACTIVE_PLACEMENT,
        sessionId: PROVISIONING_PLACEMENT.sessionId,
        generation: PROVISIONING_PLACEMENT.generation + 1,
      };
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          resumeProvisioning: async (_placement, _core, report, admit) => {
            if (!admit) {
              throw new Error("Recovery fixture requires admission");
            }
            return await admit(async () => {
              entered.resolve();
              await finish.promise;
              if (outcome === "incomplete") {
                return undefined;
              }
              report?.(active);
              return active;
            });
          },
        }),
        (_request, run) => run(),
      );
      const recovery = coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {});
      await entered.promise;
      const waiting = coordinated.waitForInitialPlacement({
        ...PROVISIONING_PLACEMENT,
        generation: PROVISIONING_PLACEMENT.generation + (outcome === "stale-generation" ? 1 : 0),
      });
      void waiting.catch(() => undefined);
      try {
        if (outcome === "stale-generation") {
          await expect(waiting).rejects.toThrow("no matching live dispatch owner");
        }
        finish.resolve();
        await recovery;
        if (outcome === "active") {
          await expect(waiting).resolves.toEqual(active);
        }
        if (outcome === "incomplete") {
          await expect(waiting).rejects.toThrow("did not publish a ready placement");
        }
      } finally {
        finish.resolve();
        await Promise.allSettled([waiting, recovery]);
      }
    },
  );

  it("reclaims an idle session before a disjoint dispatch finishes while preserving its fence", async () => {
    const cloudStarted = createDeferredCore();
    const releaseCloud = createDeferredCore();
    let reclaimed = false;
    const dispatch = vi.fn(async (request: WorkerPlacementDispatchRequest) => {
      if (request.sessionId === "cloud") {
        cloudStarted.resolve();
        await releaseCloud.promise;
      }
      return { ...ACTIVE_PLACEMENT, ...request };
    });
    const service = createCoordinatorTestService({
      dispatch,
      reclaim: async (_request, _authorize, _beforeDrain, serialize) => {
        if (!serialize) {
          throw new Error("Reclaim fixture requires the placement fence");
        }
        return await serialize(async () => {
          reclaimed = true;
          return { ...ACTIVE_PLACEMENT, state: "reclaimed" };
        });
      },
    });
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
    const cloud = coordinated.dispatch({
      ...REQUEST,
      sessionId: "cloud",
      sessionKey: "agent:main:cloud",
    });
    await cloudStarted.promise;
    const stop = coordinated.reclaim(REQUEST);
    let later: Promise<unknown> | undefined;
    try {
      await setImmediatePromise();
      expect(reclaimed).toBe(true);
      expect((await stop).state).toBe("reclaimed");
      later = coordinated.dispatch({
        ...REQUEST,
        sessionId: "later",
        sessionKey: "agent:main:later",
      });
      await setImmediatePromise();
      expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(["cloud"]);
    } finally {
      releaseCloud.resolve();
      await Promise.all([cloud, stop, later]);
    }
    expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(["cloud", "later"]);
  });

  it.each(["full", "targeted", "recovery"] as const)(
    "bounds dispatch joins to the original provider cohort before %s maintenance",
    async (kind) => {
      const cloudStarted = createDeferredCore();
      const releaseCloud = createDeferredCore();
      const releaseMac = createDeferredCore();
      const maintenanceStarted = createDeferredCore();
      const releaseMaintenance = createDeferredCore();
      const dispatch = vi.fn(async (request: WorkerPlacementDispatchRequest) => {
        if (request.sessionId === "cloud") {
          cloudStarted.resolve();
          await releaseCloud.promise;
        } else if (request.sessionId === REQUEST.sessionId) {
          await releaseMac.promise;
        }
        return { ...ACTIVE_PLACEMENT, ...request };
      });
      const maintain = async () => {
        maintenanceStarted.resolve();
        await releaseMaintenance.promise;
      };
      const service = createCoordinatorTestService({
        dispatch,
        reconcileActive: maintain,
        resumeProvisioning: admittedRecovery(maintain),
      });
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
      const cloud = coordinated.dispatch({ ...REQUEST, sessionId: "cloud" });
      await cloudStarted.promise;
      const maintenance =
        kind === "recovery"
          ? coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {})
          : coordinated.reconcileActive(kind === "targeted" ? "worker-target" : undefined);
      const mac = coordinated.dispatch(REQUEST);
      let callsBeforeCloudSettled: string[];
      let late: Promise<unknown> | undefined;
      let third: Promise<unknown> | undefined;
      let laterMaintenance: Promise<unknown> | undefined;
      try {
        await setImmediatePromise();
        callsBeforeCloudSettled = dispatch.mock.calls.map(([request]) => request.sessionId);
        releaseCloud.resolve();
        await cloud;
        laterMaintenance = coordinated.reconcileActive("worker-later");
        third = coordinated.dispatch({ ...REQUEST, sessionId: "third" });
        await setImmediatePromise();
        expect(dispatch.mock.calls.some(([request]) => request.sessionId === "third")).toBe(false);
        releaseMac.resolve();
        await maintenanceStarted.promise;
        late = coordinated.dispatch({ ...REQUEST, sessionId: "late" });
        await setImmediatePromise();
        expect(dispatch.mock.calls.some(([request]) => request.sessionId === "late")).toBe(false);
      } finally {
        releaseCloud.resolve();
        releaseMac.resolve();
        releaseMaintenance.resolve();
        await Promise.all([cloud, maintenance, mac, third, laterMaintenance, late]);
      }
      expect(callsBeforeCloudSettled).toEqual(["cloud", REQUEST.sessionId]);
    },
  );

  it.each(
    [
      { kind: "move", order: "before" },
      { kind: "move", order: "after" },
      { kind: "reclaim", order: "before" },
      { kind: "reclaim", order: "after" },
      { kind: "destroy", order: "before" },
      { kind: "destroy", order: "after" },
    ].flatMap(({ kind, order }) =>
      ["sweep", "recovery"].map((maintenanceKind) => ({ kind, order, maintenanceKind })),
    ),
  )(
    "a queued $kind closes dispatch admission $order pending $maintenanceKind",
    async ({ kind, order, maintenanceKind }) => {
      const cloudStarted = createDeferredCore();
      const releaseCloud = createDeferredCore();
      const exclusiveStarted = createDeferredCore();
      const releaseExclusive = createDeferredCore();
      const destroyError = new Error("Provider teardown failed");
      const dispatch = vi.fn(async (request: WorkerPlacementDispatchRequest) => {
        if (request.sessionId === "cloud") {
          cloudStarted.resolve();
          await releaseCloud.promise;
        }
        return { ...ACTIVE_PLACEMENT, ...request };
      });
      const exclusive = async () => {
        exclusiveStarted.resolve();
        await releaseExclusive.promise;
        return LOCAL_PLACEMENT;
      };
      const service = createCoordinatorTestService({
        dispatch,
        move: exclusive,
        reclaim: async (_request, _authorize, _beforeDrain, serialize) => {
          if (!serialize) {
            throw new Error("Reclaim fixture requires the placement fence");
          }
          return await serialize(exclusive);
        },
        forceDestroyEnvironment: async () => {
          await exclusive();
          throw destroyError;
        },
        reconcileActive: async () => {},
        resumeProvisioning: admittedRecovery(async () => {}),
      });
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
      const maintain = () =>
        maintenanceKind === "sweep"
          ? coordinated.reconcileActive()
          : coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {});
      const cloud = coordinated.dispatch({ ...REQUEST, sessionId: "cloud" });
      await cloudStarted.promise;
      let maintenance = order === "after" ? maintain() : undefined;
      const hard =
        kind === "move"
          ? coordinated.move(MOVE_REQUEST)
          : kind === "reclaim"
            ? coordinated.reclaim(REQUEST)
            : coordinated.forceDestroyEnvironment("worker-exclusive").then(
                () => {
                  throw new Error("Expected teardown failure");
                },
                (error: unknown) => expect(error).toBe(destroyError),
              );
      // Move admission yields before it reserves its placement fence.
      await setImmediatePromise();
      maintenance ??= maintain();
      const later = coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
      try {
        await setImmediatePromise();
        expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(["cloud"]);
        releaseCloud.resolve();
        await exclusiveStarted.promise;
        await setImmediatePromise();
        expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(["cloud"]);
      } finally {
        releaseCloud.resolve();
        releaseExclusive.resolve();
        await Promise.all([cloud, maintenance, hard, later]);
      }
      expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual([
        "cloud",
        "unrelated",
      ]);
    },
  );
});
