import { expect, it } from "vitest";
import { createReadBarrier, observeSettlement } from "../../infra/sqlite-readonly.test-support.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  ACTIVE_PLACEMENT,
  createCoordinatorTestService,
  REQUEST,
} from "./placement-dispatch-coordinator.test-support.js";

it("does not fence independent dispatch behind a failing report baseline", async () => {
  const baseline = createReadBarrier();
  const reportError = new Error("synthetic reporting failure");
  const states = ["provisioning"];
  const coordinated = coordinateWorkerPlacementDispatch(
    createCoordinatorTestService({
      dispatch: async () => {
        states.push("active");
        return ACTIVE_PLACEMENT;
      },
      reconcile: async () => {
        states.push("reclaimed");
      },
    }),
    (_request, run) => run(),
    async () => {
      await baseline.hold(undefined);
      throw reportError;
    },
  );
  const sweep = coordinated.reconcile();
  const sweepOutcome = sweep.catch((error: unknown) => error);
  await baseline.entered.promise;
  const dispatch = coordinated.dispatch(REQUEST);
  try {
    await dispatch;
    expect(states).toEqual(["provisioning", "active"]);
    baseline.resume.resolve();
    expect(await sweepOutcome).toBe(reportError);
    expect(states).toEqual(["provisioning", "active"]);
  } finally {
    baseline.resume.resolve();
    await Promise.all([sweepOutcome, dispatch]);
  }
});

it("reports completed sweep work while independent dispatch and destruction settle", async () => {
  const operation = createReadBarrier();
  const dispatchGate = createReadBarrier();
  const report = createReadBarrier();
  const events: string[] = [];
  let reported: string[] | undefined;
  const destructionError = new Error("synthetic environment teardown failure");
  const coordinated = coordinateWorkerPlacementDispatch(
    createCoordinatorTestService({
      dispatch: async () => {
        await dispatchGate.hold(undefined);
        events.push("dispatch");
        return ACTIVE_PLACEMENT;
      },
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
  const dispatch = coordinated.dispatch(REQUEST);
  const destroying = coordinated.forceDestroyEnvironment("worker-other");
  const destructionOutcome = expect(destroying).rejects.toBe(destructionError);
  try {
    await dispatchGate.entered.promise;
    await destructionOutcome;
    expect(events).toEqual(["destroy"]);
    operation.resume.resolve();
    await report.entered.promise;
    expect(reported).toEqual(["destroy", "sweep"]);
    dispatchGate.resume.resolve();
    await dispatch;
    expect(sweepOutcome.settled).toBe(false);
  } finally {
    operation.resume.resolve();
    dispatchGate.resume.resolve();
    report.resume.resolve();
    await Promise.all([sweep, dispatch, destructionOutcome]);
  }
  expect(events).toEqual(["destroy", "sweep", "dispatch"]);
});
