import { expect, it } from "vitest";
import { createReadBarrier, observeSettlement } from "../../infra/sqlite-readonly.test-support.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  admittedRecovery,
  createCoordinatorTestService,
  PROVISIONING_PLACEMENT,
} from "./placement-dispatch-coordinator.test-support.js";

it.each([false, true])(
  "reports the sweep without fencing independent recovery behind its baseline (report fails=%s)",
  async (reportFails) => {
    const baseline = createReadBarrier();
    const reportError = new Error("synthetic reporting failure");
    const states = ["provisioning"];
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        resumeProvisioning: admittedRecovery(async (_placement, core) => await core()),
        reconcile: async () => {
          states.push("reclaimed");
        },
      }),
      (_request, run) => run(),
      undefined,
      async (operation) => {
        await baseline.hold(undefined);
        if (reportFails) {
          throw reportError;
        }
        await operation();
      },
    );
    const sweep = coordinated.reconcile();
    const sweepOutcome = sweep.catch((error: unknown) => error);
    await baseline.entered.promise;
    const recovery = coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {
      states.push("active");
    });
    try {
      await recovery;
      expect(states).toEqual(["provisioning", "active"]);
      baseline.resume.resolve();
      expect(await sweepOutcome).toBe(reportFails ? reportError : undefined);
      expect(states).toEqual(
        reportFails ? ["provisioning", "active"] : ["provisioning", "active", "reclaimed"],
      );
    } finally {
      baseline.resume.resolve();
      await Promise.all([sweepOutcome, recovery]);
    }
  },
);

it("reports completed sweep work while independent recovery and destruction settle", async () => {
  const operation = createReadBarrier();
  const recoveryGate = createReadBarrier();
  const report = createReadBarrier();
  const events: string[] = [];
  let reported: string[] | undefined;
  const destructionError = new Error("synthetic environment teardown failure");
  const coordinated = coordinateWorkerPlacementDispatch(
    createCoordinatorTestService({
      resumeProvisioning: admittedRecovery(async (_placement, core) => await core()),
      reconcile: async () => {
        await operation.hold(undefined);
        events.push("sweep");
      },
      forceDestroyEnvironment: async () => {
        events.push("destroy");
        throw destructionError;
      },
    }),
    (_request, run) => run(),
    undefined,
    async (run) => {
      try {
        await run();
      } finally {
        reported = [...events];
        await report.hold(undefined);
      }
    },
  );
  const sweep = coordinated.reconcile();
  const sweepOutcome = observeSettlement(sweep);
  await operation.entered.promise;
  const recovery = coordinated.resumeProvisioning(PROVISIONING_PLACEMENT, async () => {
    await recoveryGate.hold(undefined);
    events.push("recovery");
  });
  const destroying = coordinated.forceDestroyEnvironment("worker-other");
  const destructionOutcome = expect(destroying).rejects.toBe(destructionError);
  try {
    await recoveryGate.entered.promise;
    await destructionOutcome;
    expect(events).toEqual(["destroy"]);
    operation.resume.resolve();
    await report.entered.promise;
    expect(reported).toEqual(["destroy", "sweep"]);
    recoveryGate.resume.resolve();
    await recovery;
    expect(sweepOutcome.settled).toBe(false);
  } finally {
    operation.resume.resolve();
    recoveryGate.resume.resolve();
    report.resume.resolve();
    await Promise.all([sweep, recovery, destructionOutcome]);
  }
  expect(events).toEqual(["destroy", "sweep", "recovery"]);
});
