import { expect, it, vi } from "vitest";
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

it.each(["targeted sweep", "recovery"] as const)(
  "reclaims independent sessions while %s handles a busy session",
  async (kind) => {
    const dispatchEntered = createDeferredCore();
    const dispatchRelease = createDeferredCore();
    const reclaimEntered = createDeferredCore();
    const reclaimRelease = createDeferredCore();
    const events: string[] = [];
    const stopped = { ...REQUEST, sessionId: "stopped", sessionKey: "agent:main:stopped" };
    const recover = async () => {
      events.push("recovery");
    };
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        dispatch: async (request) => {
          if (request.sessionId === REQUEST.sessionId) {
            dispatchEntered.resolve();
            await dispatchRelease.promise;
          }
          return { ...ACTIVE_PLACEMENT, ...request };
        },
        reconcileActive: async (_environmentId, admit) => {
          await admit!([REQUEST.sessionId], async (mode) => {
            expect(mode).toBe("results-only");
            await recover();
          });
        },
        resumeProvisioning: admittedRecovery(recover),
        reclaim: async (request, _authorize, _beforeDrain, serialize) =>
          await serialize!(async () => {
            events.push(`reclaim:${request.sessionId}`);
            if (request.sessionId === stopped.sessionId) {
              reclaimEntered.resolve();
              await reclaimRelease.promise;
            }
            return { ...LOCAL_PLACEMENT, ...request };
          }),
      }),
      (_request, run) => run(),
    );
    const dispatch = coordinated.dispatch(REQUEST);
    await dispatchEntered.promise;
    const recovery =
      kind === "targeted sweep"
        ? coordinated.reconcileActive("worker-active")
        : coordinated.resumeProvisioning({ ...PROVISIONING_PLACEMENT, ...REQUEST }, async () => {});
    const stop = coordinated.reclaim(stopped);
    await reclaimEntered.promise;
    await coordinated.reclaim({ ...stopped, sessionId: "other-stop" });
    expect(events).toEqual([
      ...(kind === "targeted sweep" ? ["recovery"] : []),
      "reclaim:stopped",
      "reclaim:other-stop",
    ]);
    dispatchRelease.resolve();
    await Promise.all([dispatch, recovery]);
    expect(events).toEqual(
      kind === "targeted sweep"
        ? ["recovery", "reclaim:stopped", "reclaim:other-stop"]
        : ["reclaim:stopped", "reclaim:other-stop", "recovery"],
    );
    reclaimRelease.resolve();
    await stop;
  },
);

it.each([false, true])(
  "same-session provisioning recovery follows an admitted Stop (Stop fails=%s)",
  async (fails) => {
    const reclaimEntered = createDeferredCore();
    const reclaimRelease = createDeferredCore();
    const failure = new Error("provider cleanup pending");
    const events: string[] = [];
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        dispatch: async () => ACTIVE_PLACEMENT,
        reclaim: async (_request, _authorize, _beforeDrain, serialize) =>
          await serialize!(async () => {
            events.push("reclaim:start");
            reclaimEntered.resolve();
            await reclaimRelease.promise;
            events.push("reclaim:finish");
            if (fails) {
              throw failure;
            }
            return LOCAL_PLACEMENT;
          }),
        resumeProvisioning: admittedRecovery(async () => {
          events.push("recovery");
        }),
      }),
      (_request, run) => run(),
    );
    const reclaim = coordinated.reclaim(REQUEST).catch((error: unknown) => error);
    await reclaimEntered.promise;
    const recovery = coordinated.resumeProvisioning(
      { ...PROVISIONING_PLACEMENT, ...REQUEST },
      async () => {},
    );
    await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
    expect(events).toEqual(["reclaim:start"]);
    reclaimRelease.resolve();
    await Promise.all([reclaim, recovery]);
    expect(await reclaim).toBe(fails ? failure : LOCAL_PLACEMENT);
    expect(events).toEqual(["reclaim:start", "reclaim:finish", "recovery"]);
  },
);

it("preserves a registered Move before the same session's Stop preparation finishes", async () => {
  const dispatchEntered = createDeferredCore();
  const dispatchRelease = createDeferredCore();
  const moveEntered = createDeferredCore();
  const moveRelease = createDeferredCore();
  const prepared = createDeferredCore();
  const events: string[] = [];
  const coordinated = coordinateWorkerPlacementDispatch(
    createCoordinatorTestService({
      dispatch: async (request) => {
        if (request.sessionId === REQUEST.sessionId) {
          dispatchEntered.resolve();
          await dispatchRelease.promise;
        }
        return { ...ACTIVE_PLACEMENT, ...request };
      },
      move: async () => {
        events.push("move:start");
        moveEntered.resolve();
        await moveRelease.promise;
        events.push("move:finish");
        return LOCAL_PLACEMENT;
      },
      reclaim: async (_request, _authorize, _beforeDrain, serialize, pending) => {
        prepared.resolve();
        await pending?.settled;
        return await serialize!(async () => {
          events.push("reclaim");
          return LOCAL_PLACEMENT;
        });
      },
    }),
    (_request, run) => run(),
  );
  const dispatch = coordinated.dispatch(REQUEST);
  await dispatchEntered.promise;
  const moving = coordinated.move(MOVE_REQUEST);
  const reclaim = coordinated.reclaim(REQUEST);
  await prepared.promise;
  expect(events).toEqual([]);
  dispatchRelease.resolve();
  await moveEntered.promise;
  await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
  expect(events).toEqual(["move:start"]);
  moveRelease.resolve();
  await Promise.all([dispatch, moving, reclaim]);
  expect(events).toEqual(["move:start", "move:finish", "reclaim"]);
});

it.each(["sweep", "recovery"] as const)(
  "retains admitted %s effects before same-session cleanup while other sessions proceed",
  async (kind) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const reclaimEntered = createDeferredCore();
    const reclaimRelease = createDeferredCore();
    const prepared = createDeferredCore();
    const events: string[] = [];
    const dispatch = vi.fn(async (request: typeof REQUEST) => ({
      ...ACTIVE_PLACEMENT,
      ...request,
    }));
    const recover = async () => {
      events.push("recovery:start");
      entered.resolve();
      await release.promise;
      events.push("recovery:finish");
    };
    const coordinated = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({
        dispatch,
        reconcile: async (_mode, admit) => {
          await admit!([REQUEST.sessionId], recover);
        },
        resumeProvisioning: admittedRecovery(recover),
        reclaim: async (_request, _authorize, _beforeDrain, serialize) => {
          prepared.resolve();
          return await serialize!(async () => {
            events.push("reclaim:start");
            reclaimEntered.resolve();
            await reclaimRelease.promise;
            events.push("reclaim:finish");
            return LOCAL_PLACEMENT;
          });
        },
      }),
      (_request, run) => run(),
    );
    const recovering =
      kind === "sweep"
        ? coordinated.reconcile()
        : coordinated.resumeProvisioning({ ...PROVISIONING_PLACEMENT, ...REQUEST }, async () => {});
    await entered.promise;
    const stopping = coordinated.reclaim(REQUEST);
    await prepared.promise;
    const same = coordinated.dispatch(REQUEST);
    await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
    expect(events).toEqual(["recovery:start"]);
    expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(["unrelated"]);
    release.resolve();
    await reclaimEntered.promise;
    expect(events).toEqual(["recovery:start", "recovery:finish", "reclaim:start"]);
    expect(dispatch).toHaveBeenCalledOnce();
    reclaimRelease.resolve();
    await Promise.all([recovering, stopping, same]);
    expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual([
      "unrelated",
      REQUEST.sessionId,
    ]);
  },
);
