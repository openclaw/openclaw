import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  ACTIVE_PLACEMENT,
  PROVISIONING_PLACEMENT,
  admittedRecovery,
  createCoordinatorTestService,
} from "./placement-dispatch-coordinator.test-support.js";
import type { WorkerPlacementDispatchAdmission } from "./service-contract.js";

const admit: WorkerPlacementDispatchAdmission = async (_request, run, authorize) => {
  authorize?.();
  return await run();
};

describe("worker recovery source authority", () => {
  it("does not replay a stored placement without a live requesting authority", async () => {
    const resume = vi.fn(async () => undefined);
    const service = createCoordinatorTestService({ resumeProvisioning: resume });
    const coordinated = coordinateWorkerPlacementDispatch(service, admit);
    await expect(
      coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {}),
    ).resolves.toBeUndefined();
    expect(resume).not.toHaveBeenCalled();
  });

  it("rejects a queued recovery when only its source closes", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const physical = new AbortController();
    const closed = new Error("source revoked");
    let current = true;
    const core = vi.fn(async () => {});
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        resumeProvisioning: admittedRecovery(async (_placement, run) => run()),
      }),
      async (request, run, authorize) => {
        entered.resolve();
        await release.promise;
        return await admit(request, run, authorize, physical.signal);
      },
    );
    const pending = coordinated
      .resumeProvisioning(PROVISIONING_PLACEMENT, core, () => {
        if (!current) {
          throw closed;
        }
      })
      .catch((error: unknown) => error);
    await entered.promise;
    current = false;
    release.resolve();
    expect(await pending).toBe(closed);
    expect(physical.signal.aborted).toBe(false);
    expect(core).not.toHaveBeenCalled();
  });

  it("notifies a waiting caller when a later recovery pass observes revocation", async () => {
    const physical = new AbortController();
    const closed = new Error("waiting source revoked");
    let current = true;
    const core = vi.fn(async () => {});
    const service = createCoordinatorTestService({
      resumeProvisioning: async (placement, runCore, authorize, report, runAdmitted) => {
        if (!runAdmitted) {
          throw new Error("missing admission owner");
        }
        report?.(placement);
        return await runAdmitted(async (signal) => {
          authorize();
          await runCore(signal, undefined, authorize);
          return undefined;
        });
      },
    });
    const coordinated = coordinateWorkerPlacementDispatch(service, admit, async (placement) => {
      await coordinated.resumeProvisioning(placement, core);
    });
    const waiting = coordinated
      .waitForInitialPlacement(PROVISIONING_PLACEMENT, physical.signal, () => {
        if (!current) {
          throw closed;
        }
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(core).toHaveBeenCalledOnce();
      expect(coordinated.isPlacementOperationInFlight(PROVISIONING_PLACEMENT.sessionId)).toBe(
        false,
      );
    });
    current = false;
    await expect(coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, core)).rejects.toBe(closed);
    expect(await waiting).toBe(closed);
    expect(core).toHaveBeenCalledOnce();
    expect(physical.signal.aborted).toBe(false);
    expect(coordinated.hasInitialRecoveryRequest(PROVISIONING_PLACEMENT)).toBe(false);
  });

  it("closes a retained recovery grant after its waiting operation finishes", async () => {
    let retained: (() => void) | undefined;
    const active = {
      ...ACTIVE_PLACEMENT,
      sessionId: PROVISIONING_PLACEMENT.sessionId,
      environmentId: PROVISIONING_PLACEMENT.environmentId,
      generation: PROVISIONING_PLACEMENT.generation + 2,
    };
    const service = createCoordinatorTestService({
      resumeProvisioning: async (placement, _core, authorize, report, runAdmitted) => {
        if (!runAdmitted) {
          throw new Error("missing admission owner");
        }
        retained = authorize;
        report?.(placement);
        return await runAdmitted(async () => {
          authorize();
          return active;
        });
      },
    });
    const coordinated = coordinateWorkerPlacementDispatch(service, admit, async (placement) => {
      await coordinated.resumeProvisioning(placement, async () => {});
    });
    await expect(
      coordinated.waitForInitialPlacement(PROVISIONING_PLACEMENT, undefined, () => {}),
    ).resolves.toEqual(active);
    if (!retained) {
      throw new Error("missing retained recovery grant");
    }
    expect(retained).toThrow("Initial worker setup request is closed");
    expect(coordinated.hasInitialRecoveryRequest(PROVISIONING_PLACEMENT)).toBe(false);
  });
});
