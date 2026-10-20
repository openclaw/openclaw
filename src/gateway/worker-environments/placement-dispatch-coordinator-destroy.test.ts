import { expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  ACTIVE_PLACEMENT,
  createCoordinatorTestService,
  PROVISIONING_PLACEMENT,
  REQUEST,
} from "./placement-dispatch-coordinator.test-support.js";
import { createDispatchEnvironmentFixtures } from "./placement-dispatch-test-fixtures.js";

it.each(["in-flight", "success", "failure", "discovery failure"] as const)(
  "holds forced-destroy admission while unrelated sessions proceed: %s",
  async (scenario) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const failure = new Error(scenario);
    const inFlight = scenario === "in-flight";
    const dispatched: string[] = [];
    let finished = false;
    let destroyed = false;
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        dispatch: async (request, report) => {
          if (scenario === "discovery failure") {
            throw new Error("Unexpected placement fixture operation");
          }
          dispatched.push(request.sessionId);
          if (inFlight && request.sessionId === REQUEST.sessionId) {
            report?.({ ...PROVISIONING_PLACEMENT, ...request });
            entered.resolve();
            await release.promise;
            finished = true;
          }
          return { ...ACTIVE_PLACEMENT, ...request };
        },
        readEnvironmentSessionIds: async () => {
          if (scenario === "discovery failure") {
            throw failure;
          }
          return inFlight ? [] : [REQUEST.sessionId];
        },
        forceDestroyEnvironment: async () => {
          destroyed = true;
          if (inFlight) {
            expect(finished).toBe(true);
          } else {
            entered.resolve();
            await release.promise;
            if (scenario === "failure") {
              throw failure;
            }
          }
          return createDispatchEnvironmentFixtures().destroyedEnvironment(2);
        },
      }),
      (_request, run) => run(),
    );
    const environmentId = inFlight ? PROVISIONING_PLACEMENT.environmentId : "worker-shared";
    if (scenario === "discovery failure") {
      await expect(coordinated.forceDestroyEnvironment(environmentId)).rejects.toBe(failure);
      expect(destroyed).toBe(false);
      return;
    }
    const dispatching = inFlight ? coordinated.dispatch(REQUEST) : undefined;
    if (inFlight) {
      await entered.promise;
    }
    const destroying = coordinated
      .forceDestroyEnvironment(environmentId)
      .catch((error: unknown) => error);
    if (!inFlight) {
      await entered.promise;
    }
    const owner = inFlight ? undefined : coordinated.dispatch(REQUEST);
    try {
      await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
      if (!inFlight) {
        expect(dispatched).toEqual(["unrelated"]);
      }
    } finally {
      release.resolve();
      await Promise.all([dispatching, owner, destroying]);
    }
    if (!inFlight) {
      expect(dispatched).toEqual(["unrelated", REQUEST.sessionId]);
    }
    if (scenario === "failure") {
      expect(await destroying).toBe(failure);
    } else {
      expect(await destroying).toMatchObject({ state: "destroyed" });
    }
  },
);
