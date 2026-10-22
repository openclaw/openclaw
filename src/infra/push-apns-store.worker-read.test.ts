import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  loadApnsRegistrations,
  type ApnsRegistration,
} from "./push-apns-store.js";

type Execute = (
  context: OpenClawStateWorkerContext,
  command: { type: string; input: unknown },
) => Promise<unknown>;
const mocks = vi.hoisted(() => {
  const native = vi.fn(() => {
    throw new Error("APNs lookup must not open host SQLite");
  });
  return {
    execute: vi.fn<Execute>(),
    native,
    forbid: (...names: string[]) => Object.fromEntries(names.map((name) => [name, native])),
  };
});
const expectCommand = (type: string, input: unknown) =>
  expect(mocks.execute.mock.calls[0]?.[1]).toEqual({ type, input });
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  executeOpenClawStateWorker: mocks.execute,
}));
// mock-isolation: Forwarding tests must never open or write host SQLite.
vi.mock("../state/openclaw-state-db.js", () =>
  mocks.forbid("openOpenClawStateDatabase", "runOpenClawStateWriteTransaction"),
);
vi.mock("../state/openclaw-state-db-cache.js", () => ({
  captureOpenClawStateDatabaseReadAdmission: (databasePath: string) => ({
    databasePath,
    identity: { key: `path:${databasePath}`, canonicalPath: databasePath },
    assertCurrent: () => {},
  }),
}));
vi.mock("../state/openclaw-state-db-async-lifecycle.js", () => ({
  getOpenClawDatabaseMaintenanceScope: () => undefined,
}));
// mock-isolation: Worker-read forwarding must not decode or validate APNs rows on the host.
vi.mock("./push-apns-relay-url.js", () =>
  mocks.forbid("normalizeApnsRelayBaseUrl", "normalizePersistedApnsRelayBaseUrl"),
);
// mock-isolation: APNs rows are decoded in the worker, never on this host path.
vi.mock("./kysely-sync.js", () =>
  mocks.forbid("executeSqliteQuerySync", "executeSqliteQueryTakeFirstSync", "getNodeSqliteKysely"),
);

const registration: ApnsRegistration = {
  nodeId: "device-a",
  transport: "direct",
  token: "abcd1234".repeat(4),
  topic: "ai.openclaw.ios",
  environment: "sandbox",
  updatedAtMs: 7,
};
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  expect(mocks.native).not.toHaveBeenCalled();
});

it("does not create storage for blank single or invalid-only batch inputs", async () => {
  await expect(loadApnsRegistration(" \t ", "/synthetic/unused")).resolves.toBeNull();
  await expect(
    loadApnsRegistrations(["", " \n", "x".repeat(257)], "/synthetic/unused"),
  ).resolves.toEqual([]);
  expect(mocks.execute).not.toHaveBeenCalled();
});
it.each([
  { nodeId: "x".repeat(257), failure: undefined },
  { nodeId: "device-a", failure: new Error("invalid APNs registration row") },
])("keeps the single lookup's worker result for $nodeId", async ({ nodeId, failure }) => {
  mocks.execute.mockImplementation(() =>
    failure ? Promise.reject(failure) : Promise.resolve(null),
  );
  const pending = loadApnsRegistration(` ${nodeId} `, "/synthetic/apns-a");
  if (failure) {
    await expect(pending).rejects.toBe(failure);
  } else {
    await expect(pending).resolves.toBeNull();
  }
  expectCommand("apns.registration.read", nodeId);
});
it("captures the original inputs and relative state path before waiting", async () => {
  const ready = createDeferredCore<Map<string, ApnsRegistration>>();
  mocks.execute.mockReturnValue(ready.promise);
  const cwd = vi.spyOn(process, "cwd").mockReturnValue("/synthetic/original");
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/ambient-a");
  const inputs = [" device-a ", "missing", "device-a", "", "x".repeat(257)];
  const pending = loadApnsRegistrations(inputs, "relative-state");
  inputs.splice(0, inputs.length, "replacement");
  cwd.mockReturnValue("/synthetic/replacement");
  vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/ambient-b");
  ready.resolve(new Map([["device-a", registration]]));
  await expect(pending).resolves.toEqual([
    { nodeId: " device-a ", registration },
    { nodeId: "device-a", registration },
  ]);
  expect(mocks.execute.mock.calls[0]?.[0].admission.databasePath).toBe(
    path.join("/synthetic/original/relative-state", "state/openclaw.sqlite"),
  );
  expectCommand("apns.registrations.read", ["device-a", "missing"]);
});
it.each([false, new Error("cleanup refused")])(
  "awaits conditional cleanup without host SQLite: %s",
  async (result) => {
    const ready = createDeferredCore<boolean>();
    void ready.promise.catch(() => {});
    mocks.execute.mockReturnValue(ready.promise);
    const observed = { ...registration };
    const completed = vi.fn();
    const pending = clearApnsRegistrationIfCurrent({
      nodeId: " device-a ",
      registration: observed,
      baseDir: "/synthetic/apns-a",
    });
    const outcome = pending.then(completed, (error: unknown) => error);
    observed.updatedAtMs += 1;
    expect(completed).not.toHaveBeenCalled();
    if (result instanceof Error) {
      ready.reject(result);
      expect(await outcome).toBe(result);
      expect(completed).not.toHaveBeenCalled();
    } else {
      ready.resolve(result);
      await outcome;
      expect(completed).toHaveBeenCalledWith(result);
    }
    expectCommand("apns.registration.clearIfCurrent", {
      nodeId: "device-a",
      registration,
      nowMs: expect.any(Number),
    });
  },
);
