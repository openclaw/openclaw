import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { Actor } from "./sqlite-worker-broker.types.js";
import {
  createSqliteWorkerClient,
  runSqliteWorkerClientOperation,
} from "./sqlite-worker-client.js";

type Operations = { write: { input: string; output: string } };
const closedError = { code: "closed", message: "SQLite worker store is closed" };

function createActor(): Actor {
  return {
    nativeStopped: Promise.resolve(),
    markNativeStopped() {},
    id: 1,
    key: "client-fixture",
    databasePath: "/fixture/state.sqlite",
    pathReferences: new Map([["/fixture/state.sqlite", 1]]),
    moduleUrl: "file:///fixture/sqlite-backend.js",
    inputHash: "client-fixture",
    get slot(): never {
      throw new Error("Client scope must not access the broker's native Worker slot");
    },
    references: 1,
    opened: Promise.resolve(),
    openDispatch: { dispatched: true },
    initialized: true,
    backendClosed: false,
  };
}

it.each(["missing", "sealed"] as const)(
  "refuses a %s client before entering an operation or dispatching work",
  async (boundary) => {
    const dispatch = vi.fn(async () => "committed");
    const { client, store } = createSqliteWorkerClient<Operations>({
      actor: createActor(),
      isDraining: () => boundary === "sealed",
      isAvailable: () => true,
      dispatch,
      release: async () => {},
    });
    const operation = vi.fn(() => store.execute({ type: "write", input: "must not enter" }));
    const track = vi.fn(() => () => {});
    const assertCurrent = vi.fn();
    const createAdmission = vi.fn(() => {
      throw new Error("Refused operation must not acquire admission");
    });

    await expect(
      runSqliteWorkerClientOperation(
        boundary === "missing" ? undefined : client,
        operation,
        undefined,
        track,
        assertCurrent,
        createAdmission,
      ),
    ).rejects.toMatchObject(closedError);
    expect(operation).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(createAdmission).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    await store.close();
  },
);

it("lets an admitted scope finish through close before releasing its owner", async () => {
  const resume = createDeferred();
  const dispatched = createDeferred();
  const committed = createDeferred<string>();
  const events: string[] = [];
  let draining = false;
  const release = vi.fn(async () => {
    events.push("released");
  });
  const { client, store } = createSqliteWorkerClient<Operations>({
    actor: createActor(),
    isDraining: () => draining,
    isAvailable: () => true,
    dispatch: () => {
      events.push("dispatched");
      dispatched.resolve();
      return committed.promise;
    },
    release,
  });
  const accepted = runSqliteWorkerClientOperation<Operations, string>(
    client,
    async (scope) => {
      await resume.promise;
      const result = await scope.execute({ type: "write", input: "accepted before close" });
      events.push("completed");
      return result;
    },
    undefined,
    () => () => {},
  );
  draining = true;
  const closing = store.close();
  const lateOperation = vi.fn(async () => "must not enter");
  try {
    await expect(
      runSqliteWorkerClientOperation(client, lateOperation, undefined, () => () => {}),
    ).rejects.toMatchObject(closedError);
    await expect(store.execute({ type: "write", input: "after close" })).rejects.toMatchObject(
      closedError,
    );
    expect(lateOperation).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    resume.resolve();
    await Promise.race([dispatched.promise, accepted]);
    expect(release).not.toHaveBeenCalled();
    committed.resolve("committed");
    await expect(accepted).resolves.toBe("committed");
    await closing;
    expect(events).toEqual(["dispatched", "completed", "released"]);
    expect(release).toHaveBeenCalledOnce();
  } finally {
    resume.resolve();
    committed.resolve("committed");
    await Promise.allSettled([accepted, closing]);
  }
});
