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
import { createDispatchEnvironmentFixtures } from "./placement-dispatch-test-fixtures.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";

type DispatchService = WorkerPlacementDispatchService;

describe("worker placement session admission", () => {
  it.each(["dispatch", "reclaim"] as const)(
    "admits unrelated device %s while a reconciliation provider teardown never settles",
    async (kind) => {
      const teardownEntered = createDeferredCore();
      const teardown = createDeferredCore();
      const deviceEntered = createDeferredCore();
      const deviceRequest = {
        ...REQUEST,
        sessionId: "device-session",
        sessionKey: "agent:main:device-session",
        profileId: "device:node-independent",
        deviceId: "node-independent",
      };
      const cloudDestroy = vi.fn(async () => {
        teardownEntered.resolve();
        await teardown.promise;
      });
      const deviceProvision = vi.fn(async () => {
        deviceEntered.resolve();
        return { ...ACTIVE_PLACEMENT, ...deviceRequest, environmentId: "worker-device" };
      });
      const deviceDestroy = vi.fn(async () => {
        deviceEntered.resolve();
        return { ...LOCAL_PLACEMENT, ...deviceRequest };
      });
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          reconcileActive: cloudDestroy,
          dispatch: deviceProvision,
          reclaim: async (_request, _authorize, _beforeDrain, serialize) => {
            if (!serialize) {
              throw new Error("Reclaim fixture requires maintenance ordering");
            }
            return await serialize(deviceDestroy);
          },
        }),
        (_request, run) => run(),
      );
      void coordinated.reconcileActive().catch(teardownEntered.reject);
      await teardownEntered.promise;
      const deviceOperation =
        kind === "dispatch"
          ? coordinated.dispatch(deviceRequest)
          : coordinated.reclaim(deviceRequest);
      void deviceOperation.catch(deviceEntered.reject);
      await deviceEntered.promise;
      await deviceOperation;
      expect(cloudDestroy).toHaveBeenCalledOnce();
      expect(kind === "dispatch" ? deviceProvision : deviceDestroy).toHaveBeenCalledOnce();
    },
  );

  it.each(["success", "failure", "cancellation"] as const)(
    "counts pending device dispatches through cleanup until %s settles",
    async (outcome) => {
      const dispatchStarted = createDeferredCore();
      const finishDispatch = createDeferredCore();
      const cleanupStarted = createDeferredCore();
      const finishCleanup = createDeferredCore();
      const controller = new AbortController();
      const terminalError = new Error(`dispatch ${outcome}`);
      const request = { ...REQUEST, deviceId: "node-one" };
      const dispatch = vi.fn<DispatchService["dispatch"]>(
        async (current, _report, _authorize, signal) => {
          const active = {
            ...ACTIVE_PLACEMENT,
            sessionId: current.sessionId,
            sessionKey: current.sessionKey,
          };
          if (current.sessionId !== request.sessionId) {
            await finishCleanup.promise;
            return active;
          }
          dispatchStarted.resolve();
          try {
            await finishDispatch.promise;
            signal?.throwIfAborted();
            if (outcome === "failure") {
              throw terminalError;
            }
            return active;
          } finally {
            cleanupStarted.resolve();
            await finishCleanup.promise;
          }
        },
      );
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({ dispatch }),
        (_request, run, _authorize, signal) => run(signal),
      );
      const first = coordinated.dispatch(request, undefined, undefined, controller.signal);
      await dispatchStarted.promise;
      const joined = coordinated.dispatch(request);
      const sibling = coordinated.dispatch({ ...request, sessionId: "sibling" });
      const remote = coordinated.dispatch({
        ...request,
        sessionId: "remote",
        executionMode: "remote-exec",
      });
      const otherDevice = coordinated.dispatch({
        ...request,
        sessionId: "other-device",
        deviceId: "node-two",
      });
      const settled = Promise.allSettled([first, joined, sibling, remote, otherDevice]);

      try {
        expect(coordinated.getPendingDeviceDispatchCount("node-one")).toBe(2);
        expect(coordinated.getPendingDeviceDispatchCount("node-one", request.sessionId)).toBe(1);
        expect(coordinated.getPendingDeviceDispatchCount("node-two")).toBe(1);
        expect(coordinated.getPendingDeviceDispatchCount("unknown-node")).toBe(0);
        if (outcome === "cancellation") {
          controller.abort(terminalError);
        }
        finishDispatch.resolve();
        await cleanupStarted.promise;
        expect(coordinated.getPendingDeviceDispatchCount("node-one")).toBe(2);
      } finally {
        finishDispatch.resolve();
        finishCleanup.resolve();
        await settled;
      }

      const results = await settled;
      expect(results.slice(0, 2)).toEqual(
        outcome === "success"
          ? [
              { status: "fulfilled", value: ACTIVE_PLACEMENT },
              { status: "fulfilled", value: ACTIVE_PLACEMENT },
            ]
          : [
              { status: "rejected", reason: terminalError },
              { status: "rejected", reason: terminalError },
            ],
      );
      expect(results.slice(2).every((result) => result.status === "fulfilled")).toBe(true);
      expect(
        dispatch.mock.calls.filter(([current]) => current.sessionId === request.sessionId),
      ).toHaveLength(1);
      expect(coordinated.getPendingDeviceDispatchCount("node-one")).toBe(0);
      expect(coordinated.getPendingDeviceDispatchCount("node-two")).toBe(0);
    },
  );

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

  it.each(["move", "recovery", "destroy"] as const)(
    "admits unrelated device dispatch while another session's %s provider never settles",
    async (kind) => {
      const providerEntered = createDeferredCore();
      const provider = createDeferredCore();
      const deviceEntered = createDeferredCore();
      const request = {
        ...REQUEST,
        sessionId: "device-session",
        sessionKey: "agent:main:device-session",
        deviceId: "node-independent",
      };
      const blockProvider = async () => {
        providerEntered.resolve();
        await provider.promise;
        return LOCAL_PLACEMENT;
      };
      const dispatch = vi.fn(async () => {
        deviceEntered.resolve();
        return { ...ACTIVE_PLACEMENT, ...request };
      });
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          dispatch,
          move: blockProvider,
          resumeProvisioning: admittedRecovery(async () => {
            await blockProvider();
          }),
          readEnvironmentSessionIds: async () => [REQUEST.sessionId],
          forceDestroyEnvironment: async () => {
            await blockProvider();
            return createDispatchEnvironmentFixtures().destroyedEnvironment(2);
          },
        }),
        (_request, run) => run(),
      );
      const blocked =
        kind === "move"
          ? coordinated.move(MOVE_REQUEST)
          : kind === "recovery"
            ? coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {})
            : coordinated.forceDestroyEnvironment("worker-cloud");
      await providerEntered.promise;
      const device = coordinated.dispatch(request);
      void device.catch(deviceEntered.reject);
      try {
        await deviceEntered.promise;
        await device;
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        provider.resolve();
        await Promise.all([blocked, device]);
      }
    },
  );

  it.each(["full", "targeted"] as const)(
    "%s recovery admits only result recovery while the session is busy",
    async (kind) => {
      const dispatchEntered = createDeferredCore();
      const releaseDispatch = createDeferredCore();
      const recover = vi.fn(async (_mode?: "results-only") => {});
      const admissionAttempted = createDeferredCore();
      const admitted: boolean[] = [];
      const dispatch = vi.fn(async (request: WorkerPlacementDispatchRequest) => {
        if (request.sessionId === REQUEST.sessionId) {
          dispatchEntered.resolve();
          await releaseDispatch.promise;
        }
        return { ...ACTIVE_PLACEMENT, ...request };
      });
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          dispatch,
          reconcileActive: async (_environmentId, admit) => {
            const unit = admit!([REQUEST.sessionId], recover);
            admissionAttempted.resolve();
            admitted.push(await unit);
          },
        }),
        (_request, run) => run(),
      );
      const first = coordinated.dispatch(REQUEST);
      await dispatchEntered.promise;
      const sweep = coordinated.reconcileActive(kind === "targeted" ? "worker-active" : undefined);
      await admissionAttempted.promise;
      await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
      if (kind === "full") {
        expect(recover).not.toHaveBeenCalled();
        await sweep;
        expect(admitted).toEqual([false]);
      } else {
        expect(recover).toHaveBeenCalledExactlyOnceWith("results-only");
      }
      releaseDispatch.resolve();
      await Promise.all([first, sweep]);
      if (kind === "full") {
        await coordinated.reconcileActive();
      }
      expect(recover).toHaveBeenCalledOnce();
      expect(admitted).toEqual(kind === "full" ? [false, true] : [true]);
    },
  );
});
