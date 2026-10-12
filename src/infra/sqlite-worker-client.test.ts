import { serialize } from "node:v8";
import { expect, it, vi } from "vitest";
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

it("attributes queued commands without changing wire bytes or exposing private command suffixes", async () => {
  type DiagnosticOperations = Record<string, { input: { value: string }; output: string }>;
  const dispatch = vi
    .fn<Parameters<typeof createSqliteWorkerClient<DiagnosticOperations>>[0]["dispatch"]>()
    .mockResolvedValue("committed");
  const { store } = createSqliteWorkerClient<DiagnosticOperations>({
    actor: createActor(),
    isDraining: () => false,
    isAvailable: () => true,
    dispatch,
    release: async () => {},
  });
  const cases = [
    ["audit.writer.process", "audit.writer.process"],
    ["audit.writer.prune", "audit.writer.prune"],
    ["database.inspectIdle", "database.inspectIdle"],
    ["stateLease.renew", "stateLease.renew"],
    ["capture.recordEventWithPayload", "capture"],
    ["workerInference.complete", "workerInference"],
    ["session.entry.read", "sessions"],
    ["pluginState.get", "plugin_state"],
    ["audit.private-customer-123", "audit"],
    ["private-customer-123.execute", "execute"],
    ["unrecognized", "execute"],
  ] as const;
  try {
    for (const [type, requestClass] of cases) {
      const command = { type, input: { value: "synthetic-private-payload" } };
      await expect(store.execute(command)).resolves.toBe("committed");
      expect(dispatch).toHaveBeenLastCalledWith(
        serialize(command),
        undefined,
        undefined,
        undefined,
        undefined,
        requestClass,
      );
    }
    expect(dispatch).toHaveBeenCalledTimes(cases.length);
  } finally {
    await store.close();
  }
});
