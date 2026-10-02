import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import {
  ACTIVE_PLACEMENT,
  createCoordinatorTestService,
  LOCAL_PLACEMENT,
  MOVE_REQUEST,
  PROVISIONING_PLACEMENT,
  REQUEST,
} from "./placement-dispatch-coordinator.test-support.js";
import { createDispatchEnvironmentFixtures } from "./placement-dispatch-test-fixtures.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";

describe("worker placement forced-destroy admission", () => {
  it.each(["dispatch", "move"] as const)(
    "reserves attached sessions before the destroy owner read so later %s waits",
    async (kind) => {
      const owners = createDeferredCore<string[]>();
      const admitted = createDeferredCore();
      const events: string[] = [];
      const service = {
        ...createCoordinatorTestService({
          readEnvironmentSessionIds: () => owners.promise,
          forceDestroyEnvironment: async () => {
            events.push("destroy");
            return createDispatchEnvironmentFixtures().destroyedEnvironment(2);
          },
          dispatch: async () => {
            events.push("dispatch");
            return ACTIVE_PLACEMENT;
          },
          move: async () => {
            events.push("move");
            return LOCAL_PLACEMENT;
          },
        }),
        getEnvironmentAttachedSessionIds: () => [REQUEST.sessionId],
      };
      const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => {
        const result = run();
        admitted.resolve();
        return result;
      });
      const destroying = coordinated.forceDestroyEnvironment("worker-active");
      const later =
        kind === "dispatch" ? coordinated.dispatch(REQUEST) : coordinated.move(MOVE_REQUEST);
      await admitted.promise;
      owners.resolve([REQUEST.sessionId]);
      await Promise.all([destroying, later]);
      expect(events).toEqual(["destroy", kind]);
    },
  );

  it.each([false, true])(
    "settles overlapping destroys when attached owners grow=%s",
    async (grow) => {
      const firstReadEntered = createDeferredCore();
      const firstOwners = createDeferredCore<string[]>();
      const secondOwners = createDeferredCore<string[]>();
      const firstCleanup = vi.fn();
      const secondCleanup = vi.fn();
      const events: string[] = [];
      const attached = [REQUEST.sessionId];
      const durableRequest = {
        ...REQUEST,
        sessionId: "durable-owner",
        sessionKey: "agent:main:durable-owner",
      };
      let reads = 0;
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          getEnvironmentAttachedSessionIds: () => attached,
          readEnvironmentSessionIds: () => {
            if (reads++ === 0) {
              firstReadEntered.resolve();
              return firstOwners.promise;
            }
            return secondOwners.promise;
          },
          forceDestroyEnvironment: async (_environmentId, onCleanupError) => {
            events.push(onCleanupError === firstCleanup ? "first" : "second");
            return createDispatchEnvironmentFixtures().destroyedEnvironment(2);
          },
          dispatch: async (request) => {
            events.push("dispatch");
            return { ...ACTIVE_PLACEMENT, ...request };
          },
        }),
        (_request, run) => run(),
      );
      const first = coordinated.forceDestroyEnvironment("worker-active", firstCleanup);
      await firstReadEntered.promise;
      if (grow) {
        attached.push(durableRequest.sessionId);
      }
      const second = coordinated.forceDestroyEnvironment("worker-active", secondCleanup);
      const later = grow ? coordinated.dispatch(durableRequest) : Promise.resolve();
      secondOwners.resolve([REQUEST.sessionId, "durable-owner"]);
      firstOwners.resolve([REQUEST.sessionId, "durable-owner"]);
      await Promise.all([first, second, later]);
      expect(events).toEqual(grow ? ["first", "second", "dispatch"] : ["first", "second"]);
    },
  );

  it.each(["queued recovery", "Stop preparation"] as const)(
    "skips a durable-only owner with busy %s during discovery",
    async (kind) => {
      const readEntered = createDeferredCore();
      const owners = createDeferredCore<string[]>();
      const operationEntered = createDeferredCore();
      const releaseOperation = createDeferredCore();
      const destroyEntered = createDeferredCore();
      const releaseDestroy = createDeferredCore();
      const events: string[] = [];
      const runOperation = async () => {
        events.push("operation:start");
        operationEntered.resolve();
        await releaseOperation.promise;
        events.push("operation:finish");
      };
      const coordinated = coordinateWorkerPlacementDispatch(
        createCoordinatorTestService({
          getEnvironmentAttachedSessionIds: () => ["attached-owner"],
          readEnvironmentSessionIds: () => {
            readEntered.resolve();
            return owners.promise;
          },
          forceDestroyEnvironment: async () => {
            events.push("destroy");
            destroyEntered.resolve();
            await releaseDestroy.promise;
            return createDispatchEnvironmentFixtures().destroyedEnvironment(2);
          },
          reconcileActive: async (_environmentId, admit) => {
            await admit!([REQUEST.sessionId], runOperation);
          },
          reclaim: async (_request, _authorize, _beforeDrain, serialize) => {
            await runOperation();
            return await serialize!(async () => LOCAL_PLACEMENT);
          },
        }),
        (_request, run) => run(),
      );
      const destroying = coordinated.forceDestroyEnvironment("worker-active");
      await readEntered.promise;
      const busy =
        kind === "queued recovery"
          ? coordinated.reconcileActive("worker-active")
          : coordinated.reclaim(REQUEST);
      await operationEntered.promise;
      owners.resolve(["attached-owner", REQUEST.sessionId]);
      try {
        await destroyEntered.promise;
        expect(events).toEqual(["operation:start", "destroy"]);
        releaseOperation.resolve();
        await busy;
      } finally {
        releaseOperation.resolve();
        releaseDestroy.resolve();
        await Promise.all([busy, destroying]);
      }
      expect(events).toEqual(["operation:start", "destroy", "operation:finish"]);
    },
  );

  it("releases attached sessions when the destroy owner read fails", async () => {
    const owners = createDeferredCore<string[]>();
    const failure = new Error("owner read failed");
    const dispatch = vi.fn(async (request: WorkerPlacementDispatchRequest) => ({
      ...ACTIVE_PLACEMENT,
      ...request,
    }));
    const destroy = vi.fn();
    const service = {
      ...createCoordinatorTestService({
        dispatch,
        readEnvironmentSessionIds: () => owners.promise,
        forceDestroyEnvironment: destroy,
      }),
      getEnvironmentAttachedSessionIds: () => [REQUEST.sessionId],
    };
    const coordinated = coordinateWorkerPlacementDispatch(service, (_request, run) => run());
    const destroying = coordinated.forceDestroyEnvironment("worker-active");
    const outcome = expect(destroying).rejects.toBe(failure);
    const later = coordinated.dispatch(REQUEST);
    await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
    const beforeFailure = dispatch.mock.calls.map(([request]) => request.sessionId);
    owners.reject(failure);
    await Promise.all([outcome, later]);
    expect(beforeFailure).toEqual(["unrelated"]);
    expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual([
      "unrelated",
      REQUEST.sessionId,
    ]);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("reserves a live placement before the destroy owner read even without an attachment", async () => {
    const dispatchEntered = createDeferredCore();
    const finishDispatch = createDeferredCore();
    const owners = createDeferredCore<string[]>();
    const events: string[] = [];
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        dispatch: async (request, report) => {
          if (request.sessionId === REQUEST.sessionId) {
            report?.({ ...PROVISIONING_PLACEMENT, ...request });
            dispatchEntered.resolve();
            await finishDispatch.promise;
            return { ...ACTIVE_PLACEMENT, environmentId: PROVISIONING_PLACEMENT.environmentId };
          }
          return { ...ACTIVE_PLACEMENT, ...request };
        },
        readEnvironmentSessionIds: () => owners.promise,
        forceDestroyEnvironment: async () => {
          events.push("destroy");
          return createDispatchEnvironmentFixtures().destroyedEnvironment(2);
        },
        move: async () => {
          events.push("move");
          return LOCAL_PLACEMENT;
        },
      }),
      (_request, run) => run(),
    );
    const dispatching = coordinated.dispatch(REQUEST);
    await dispatchEntered.promise;
    const destroying = coordinated.forceDestroyEnvironment(PROVISIONING_PLACEMENT.environmentId);
    const moving = coordinated.move(MOVE_REQUEST);
    finishDispatch.resolve();
    await dispatching;
    await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
    const beforeRead = [...events];
    owners.resolve([REQUEST.sessionId]);
    await Promise.all([destroying, moving]);
    expect(beforeRead).toEqual([]);
    expect(events).toEqual(["destroy", "move"]);
  });

  it("holds idle durable and attached owners through destroy and releases failed work", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const failure = new Error("teardown pending");
    const dispatch = vi.fn(async (request: WorkerPlacementDispatchRequest) => ({
      ...ACTIVE_PLACEMENT,
      ...request,
    }));
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        dispatch,
        getEnvironmentAttachedSessionIds: () => ["attached-session"],
        readEnvironmentSessionIds: async () => [REQUEST.sessionId, "attached-session"],
        forceDestroyEnvironment: async () => {
          entered.resolve();
          await release.promise;
          throw failure;
        },
      }),
      (_request, run) => run(),
    );
    const destroying = coordinated
      .forceDestroyEnvironment("worker-shared")
      .catch((error: unknown) => error);
    await entered.promise;
    const owner = coordinated.dispatch(REQUEST);
    const attached = coordinated.dispatch({ ...REQUEST, sessionId: "attached-session" });
    await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
    expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(["unrelated"]);
    release.resolve();
    expect(await destroying).toBe(failure);
    await Promise.all([owner, attached]);
    expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual([
      "unrelated",
      REQUEST.sessionId,
      "attached-session",
    ]);
  });
});
