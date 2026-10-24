import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  ACTIVE_PLACEMENT,
  createOperationGate,
  coordinate,
  MOVE_REQUEST,
  PROVISIONING_PLACEMENT,
  REQUEST,
} from "./placement-dispatch-coordinator.test-support.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";

type DispatchService = WorkerPlacementDispatchService;

function createCoordinatedService(
  overrides: Partial<DispatchService>,
  recover?: Parameters<typeof coordinate>[2],
) {
  return coordinate(overrides, (_request, run, _authorize, signal) => run(signal), recover);
}

const RECOVERED_PLACEMENT = {
  ...ACTIVE_PLACEMENT,
  sessionId: PROVISIONING_PLACEMENT.sessionId,
  generation: PROVISIONING_PLACEMENT.generation + 1,
};

describe("worker placement session admission", () => {
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
      const coordinated = createCoordinatedService({ dispatch });
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
      const expected =
        outcome === "success"
          ? { status: "fulfilled", value: ACTIVE_PLACEMENT }
          : { status: "rejected", reason: terminalError };
      expect(results.slice(0, 2)).toEqual([expected, expected]);
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
      const active = RECOVERED_PLACEMENT;
      let attempts = 0;
      const coordinated = createCoordinatedService(
        {
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
        },
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
    const coordinated = createCoordinatedService({}, recover);
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
      const recoveryGate = createOperationGate(undefined);
      const active = RECOVERED_PLACEMENT;
      const coordinated = createCoordinatedService({
        resumeProvisioning: async (_placement, _core, report, admit) => {
          if (!admit) {
            throw new Error("Recovery fixture requires admission");
          }
          return await admit(async () => {
            await recoveryGate.run();
            if (outcome === "incomplete") {
              return undefined;
            }
            report?.(active);
            return active;
          });
        },
      });
      const recovery = coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {});
      await recoveryGate.entered;
      const waiting = coordinated.waitForInitialPlacement({
        ...PROVISIONING_PLACEMENT,
        generation: PROVISIONING_PLACEMENT.generation + (outcome === "stale-generation" ? 1 : 0),
      });
      void waiting.catch(() => undefined);
      try {
        if (outcome === "stale-generation") {
          await expect(waiting).rejects.toThrow("no matching live dispatch owner");
        }
        recoveryGate.release();
        await recovery;
        if (outcome === "active") {
          await expect(waiting).resolves.toEqual(active);
        }
        if (outcome === "incomplete") {
          await expect(waiting).rejects.toThrow("did not publish a ready placement");
        }
      } finally {
        recoveryGate.release();
        await Promise.allSettled([waiting, recovery]);
      }
    },
  );

  it("joins same-session recovery before acknowledging a targeted pass", async () => {
    const recoveryGate = createOperationGate(undefined);
    const targetedAdmission = createDeferredCore();
    let state = "reconciling";
    const observed: Array<{ state: string; mode: "results-only" | undefined }> = [];
    const unrelated = vi.fn(async () => {});
    const coordinated = createCoordinatedService({
      reconcileActive: async (environmentId, admit) => {
        if (environmentId === undefined) {
          await admit!([REQUEST.sessionId], async () => {
            await recoveryGate.run();
            state = "failed";
          });
        } else if (environmentId === "unrelated") {
          await admit!(["unrelated"], unrelated);
        } else {
          const recovery = admit!([REQUEST.sessionId], async (mode) => {
            observed.push({ state, mode });
          });
          targetedAdmission.resolve();
          await recovery;
        }
      },
    });
    const sweep = coordinated.reconcileActive();
    await recoveryGate.entered;
    const targeted = coordinated.reconcileActive("worker-active");
    try {
      await targetedAdmission.promise;
      await coordinated.reconcileActive("unrelated");
      expect(unrelated).toHaveBeenCalledOnce();
      expect(observed).toEqual([]);
    } finally {
      recoveryGate.release();
      await Promise.all([sweep, targeted]);
    }
    expect(observed).toEqual([{ state: "failed", mode: undefined }]);
  });

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
      const coordinated = createCoordinatedService({
        dispatch,
        reconcileActive: async (_environmentId, admit) => {
          const unit = admit!([REQUEST.sessionId], recover);
          admissionAttempted.resolve();
          admitted.push(await unit);
        },
      });
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
