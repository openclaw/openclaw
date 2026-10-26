import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  ACTIVE_PLACEMENT,
  createOperationGate,
  admittedRecovery,
  coordinate as createCoordinatedService,
  LOCAL_PLACEMENT,
  MOVE_REQUEST,
  preparedReclaim,
  PROVISIONING_PLACEMENT,
  REQUEST,
} from "./placement-dispatch-coordinator.test-support.js";

it("reclaims an independent session while another Stop is blocked", async () => {
  const gate = createOperationGate(undefined);
  const coordinated = createCoordinatedService({
    reclaim: async (request, _authorize, _beforeDrain, serialize) =>
      serialize!(async () => {
        if (request.sessionId === REQUEST.sessionId) {
          await gate.run();
        }
        return { ...LOCAL_PLACEMENT, ...request };
      }),
  });
  const stopping = coordinated.reclaim(REQUEST);
  await gate.entered;
  try {
    await expect(coordinated.reclaim({ ...REQUEST, sessionId: "other" })).resolves.toMatchObject({
      sessionId: "other",
    });
  } finally {
    gate.release();
    await stopping;
  }
});

it.each([false, true])(
  "same-session provisioning recovery follows an admitted Stop (Stop fails=%s)",
  async (fails) => {
    const reclaimGate = createOperationGate(undefined);
    const failure = new Error("provider cleanup pending");
    const events: string[] = [];
    const coordinated = createCoordinatedService({
      dispatch: async () => ACTIVE_PLACEMENT,
      reclaim: preparedReclaim(async () => {
        events.push("reclaim:start");
        await reclaimGate.run();
        events.push("reclaim:finish");
        if (fails) {
          throw failure;
        }
        return LOCAL_PLACEMENT;
      }),
      resumeProvisioning: admittedRecovery(async () => {
        events.push("recovery");
      }),
    });
    const reclaim = coordinated.reclaim(REQUEST).catch((error: unknown) => error);
    await reclaimGate.entered;
    const recovery = coordinated.resumeProvisioning(
      { ...PROVISIONING_PLACEMENT, ...REQUEST },
      async () => {},
    );
    await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
    expect(events).toEqual(["reclaim:start"]);
    reclaimGate.release();
    await Promise.all([reclaim, recovery]);
    expect(await reclaim).toBe(fails ? failure : LOCAL_PLACEMENT);
    expect(events).toEqual(["reclaim:start", "reclaim:finish", "recovery"]);
  },
);

it("preserves a registered Move before the same session's Stop preparation finishes", async () => {
  const dispatchGate = createOperationGate(undefined);
  const moveGate = createOperationGate(undefined);
  const prepared = createDeferredCore();
  const events: string[] = [];
  const coordinated = createCoordinatedService({
    dispatch: async (request) => {
      if (request.sessionId === REQUEST.sessionId) {
        await dispatchGate.run();
      }
      return { ...ACTIVE_PLACEMENT, ...request };
    },
    move: async () => {
      events.push("move:start");
      await moveGate.run();
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
  });
  const dispatch = coordinated.dispatch(REQUEST);
  await dispatchGate.entered;
  const moving = coordinated.move(MOVE_REQUEST);
  const reclaim = coordinated.reclaim(REQUEST);
  await prepared.promise;
  expect(events).toEqual([]);
  dispatchGate.release();
  await moveGate.entered;
  await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
  expect(events).toEqual(["move:start"]);
  moveGate.release();
  await Promise.all([dispatch, moving, reclaim]);
  expect(events).toEqual(["move:start", "move:finish", "reclaim"]);
});

it.each(["sweep", "recovery"] as const)(
  "retains admitted %s effects before same-session cleanup while other sessions proceed",
  async (kind) => {
    const recoveryGate = createOperationGate(undefined);
    const reclaimGate = createOperationGate(undefined);
    const prepared = createDeferredCore();
    const events: string[] = [];
    const dispatch = vi.fn(async (request: typeof REQUEST) => ({
      ...ACTIVE_PLACEMENT,
      ...request,
    }));
    const recover = async () => {
      events.push("recovery:start");
      await recoveryGate.run();
      events.push("recovery:finish");
    };
    const coordinated = createCoordinatedService({
      dispatch,
      reconcile: async (_mode, admit) => {
        await admit!([REQUEST.sessionId], recover);
      },
      resumeProvisioning: admittedRecovery(recover),
      reclaim: async (_request, _authorize, _beforeDrain, serialize) => {
        prepared.resolve();
        return await serialize!(async () => {
          events.push("reclaim:start");
          await reclaimGate.run();
          events.push("reclaim:finish");
          return LOCAL_PLACEMENT;
        });
      },
    });
    const recovering =
      kind === "sweep"
        ? coordinated.reconcile()
        : coordinated.resumeProvisioning({ ...PROVISIONING_PLACEMENT, ...REQUEST }, async () => {});
    await recoveryGate.entered;
    const stopping = coordinated.reclaim(REQUEST);
    await prepared.promise;
    const same = coordinated.dispatch(REQUEST);
    await coordinated.dispatch({ ...REQUEST, sessionId: "unrelated" });
    expect(events).toEqual(["recovery:start"]);
    expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual(["unrelated"]);
    recoveryGate.release();
    await reclaimGate.entered;
    expect(events).toEqual(["recovery:start", "recovery:finish", "reclaim:start"]);
    reclaimGate.release();
    await Promise.all([recovering, stopping, same]);
    expect(dispatch.mock.calls.map(([request]) => request.sessionId)).toEqual([
      "unrelated",
      REQUEST.sessionId,
    ]);
  },
);
