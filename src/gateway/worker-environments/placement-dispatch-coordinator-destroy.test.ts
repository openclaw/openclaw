import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  ACTIVE_PLACEMENT,
  createCoordinatorTestService,
  PROVISIONING_PLACEMENT,
  REQUEST,
} from "./placement-dispatch-coordinator.test-support.js";
import { createDispatchEnvironmentFixtures } from "./placement-dispatch-test-fixtures.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";

describe("worker placement forced-destroy admission", () => {
  it("settles an in-flight placement before destroying its environment", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let finished = false;
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        dispatch: async (request, report) => {
          if (request.sessionId === REQUEST.sessionId) {
            report?.({ ...PROVISIONING_PLACEMENT, ...request });
            entered.resolve();
            await release.promise;
            finished = true;
          }
          return { ...ACTIVE_PLACEMENT, ...request };
        },
        forceDestroyEnvironment: async () => {
          expect(finished).toBe(true);
          return createDispatchEnvironmentFixtures().destroyedEnvironment(2);
        },
      }),
      (_request, run) => run(),
    );
    const dispatching = coordinated.dispatch(REQUEST);
    await entered.promise;
    const destroying = coordinated
      .forceDestroyEnvironment(PROVISIONING_PLACEMENT.environmentId)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    try {
      await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
    } finally {
      release.resolve();
      await dispatching;
    }
    expect(await destroying).toBeUndefined();
  });

  it.each(["success", "failure"] as const)(
    "holds discovered owners through destroy %s while unrelated sessions proceed",
    async (outcome) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const failure = new Error("destroy failed");
      const dispatch = vi.fn(async (request: WorkerPlacementDispatchRequest) => ({
        ...ACTIVE_PLACEMENT,
        ...request,
      }));
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          dispatch,
          readEnvironmentSessionIds: async () => [REQUEST.sessionId],
          forceDestroyEnvironment: async () => {
            entered.resolve();
            await release.promise;
            if (outcome === "failure") {
              throw failure;
            }
            return createDispatchEnvironmentFixtures().destroyedEnvironment(2);
          },
        }),
        (_request, run) => run(),
      );
      const destroying = coordinated
        .forceDestroyEnvironment("worker-shared")
        .catch((error: unknown) => error);
      await entered.promise;
      const owner = coordinated.dispatch(REQUEST);
      try {
        await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
        expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(["unrelated"]);
      } finally {
        release.resolve();
        await Promise.all([owner, destroying]);
      }
      expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual([
        "unrelated",
        REQUEST.sessionId,
      ]);
      if (outcome === "failure") {
        expect(await destroying).toBe(failure);
      } else {
        expect(await destroying).toMatchObject({ state: "destroyed" });
      }
    },
  );

  it("propagates owner discovery failure without destroying the environment", async () => {
    const failure = new Error("owner read failed");
    const destroy = vi.fn();
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        readEnvironmentSessionIds: async () => {
          throw failure;
        },
        forceDestroyEnvironment: destroy,
      }),
      (_request, run) => run(),
    );
    await expect(coordinated.forceDestroyEnvironment("worker-shared")).rejects.toBe(failure);
    expect(destroy).not.toHaveBeenCalled();
  });
});
