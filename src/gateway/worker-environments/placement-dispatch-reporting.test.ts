import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  admittedRecovery,
  createCoordinatorTestService,
  PROVISIONING_PLACEMENT,
} from "./placement-dispatch-coordinator.test-support.js";

it.each([false, true])(
  "keeps joined recovery behind the reporting baseline and settles it on failure=%s",
  async (reportFails) => {
    const reading = createDeferredCore();
    const finishRead = createDeferredCore();
    const reportError = new Error("synthetic reporting failure");
    let state = "provisioning";
    let reported = false;
    const reconcile = vi.fn(async () => {});
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        reconcile,
        resumeProvisioning: admittedRecovery(async (_placement, core) => await core()),
      }),
      (_request, run) => run(),
      undefined,
      async (operation) => {
        reading.resolve();
        await finishRead.promise;
        if (reportFails) {
          throw reportError;
        }
        const before = state;
        await operation();
        reported = before !== state;
      },
    );
    const sweep = coordinated.reconcile();
    const sweepOutcome = reportFails
      ? expect(sweep).rejects.toBe(reportError)
      : expect(sweep).resolves.toBeUndefined();
    await reading.promise;
    const recovery = coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {
      state = "active";
    });
    try {
      await setImmediate();
      expect(state).toBe("provisioning");
      finishRead.resolve();
      await Promise.all([sweepOutcome, recovery]);
      expect(state).toBe("active");
      expect(reported).toBe(!reportFails);
      expect(reconcile).toHaveBeenCalledTimes(reportFails ? 0 : 1);
    } finally {
      finishRead.resolve();
      await Promise.all([sweepOutcome, recovery]);
    }
  },
);

it("reports joined recovery before releasing the reconciliation fence", async () => {
  const operationStarted = createDeferredCore();
  const finishOperation = createDeferredCore();
  const recoveryStarted = createDeferredCore();
  const finishRecovery = createDeferredCore();
  const reportCaptured = createDeferredCore();
  const finishReport = createDeferredCore();
  const events: string[] = [];
  let reported: string[] | undefined;
  const destructionError = new Error("synthetic environment teardown failure");
  const destroy = vi.fn(async () => {
    events.push("destroy");
    throw destructionError;
  });
  const service = createCoordinatorTestService({
    reconcile: async () => {
      operationStarted.resolve();
      await finishOperation.promise;
      events.push("sweep");
    },
    resumeProvisioning: admittedRecovery(async (_placement, core) => await core()),
    forceDestroyEnvironment: destroy,
  });
  const coordinated = coordinateWorkerPlacementDispatch(
    service,
    (_request, run) => run(),
    undefined,
    async (operation) => {
      try {
        await operation();
      } finally {
        reported = [...events];
        reportCaptured.resolve();
        await finishReport.promise;
      }
    },
  );
  const sweep = coordinated.reconcile();
  await operationStarted.promise;
  const recovery = coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {
    recoveryStarted.resolve();
    await finishRecovery.promise;
    events.push("recovery");
  });
  const destroying = coordinated.forceDestroyEnvironment("worker-other");
  const destructionOutcome = expect(destroying).rejects.toBe(destructionError);
  try {
    await recoveryStarted.promise;
    finishOperation.resolve();
    await Promise.resolve();
    await Promise.resolve();
    finishRecovery.resolve();
    await reportCaptured.promise;
    expect(reported).toEqual(["sweep", "recovery"]);
    expect(destroy).not.toHaveBeenCalled();
  } finally {
    finishOperation.resolve();
    finishRecovery.resolve();
    finishReport.resolve();
    await Promise.all([sweep, recovery, destructionOutcome]);
  }
  expect(events).toEqual(["sweep", "recovery", "destroy"]);
});
