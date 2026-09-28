import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  loadApnsRegistration,
  loadApnsRegistrations,
  type ApnsRegistration,
} from "./push-apns-store.js";

const mocks = vi.hoisted(() => ({
  execute:
    vi.fn<
      (
        context: OpenClawStateWorkerContext,
        command: { type: string; input: unknown },
      ) => Promise<unknown>
    >(),
  native: vi.fn(() => {
    throw new Error("APNs lookup must not open host SQLite");
  }),
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  executeOpenClawStateWorker: mocks.execute,
}));
vi.mock("../state/openclaw-state-db.js", () => ({
  openOpenClawStateDatabase: mocks.native,
  runOpenClawStateWriteTransaction: mocks.native,
}));
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
vi.mock("./device-pairing-store.js", () => ({
  loadPairedDevicePairingStoreRecordFromDatabase: mocks.native,
}));
vi.mock("./device-pairing.js", () => ({ resolveNodePairingGeneration: mocks.native }));
vi.mock("./push-apns-store-transaction.js", () => ({
  clearApnsRegistrationFromDatabase: mocks.native,
  nextApnsRegistrationVersion: mocks.native,
}));
vi.mock("./push-apns.relay.js", () => ({
  normalizeApnsRelayBaseUrl: mocks.native,
  normalizePersistedApnsRelayBaseUrl: mocks.native,
}));
vi.mock("./kysely-sync.js", () => ({
  executeSqliteQuerySync: mocks.native,
  executeSqliteQueryTakeFirstSync: mocks.native,
  getNodeSqliteKysely: mocks.native,
}));

const registration: ApnsRegistration = {
  nodeId: "device-a",
  transport: "direct",
  token: "abcd1234".repeat(4),
  topic: "ai.openclaw.ios",
  environment: "sandbox",
  updatedAtMs: 7,
};
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("APNs registration worker reads", () => {
  it("delegates a single lookup without host SQLite", async () => {
    mocks.execute.mockResolvedValue(registration);
    await expect(loadApnsRegistration(" device-a ", "/synthetic/apns-a")).resolves.toEqual(
      registration,
    );
    expect(mocks.execute.mock.calls[0]?.[1]).toEqual({
      type: "apns.registration.read",
      input: "device-a",
    });
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it("delegates a batch lookup without host SQLite", async () => {
    mocks.execute.mockResolvedValue(new Map([["device-a", registration]]));
    await expect(
      loadApnsRegistrations(
        [" device-a ", "missing", "device-a", "", "x".repeat(257)],
        "/synthetic/apns-a",
      ),
    ).resolves.toEqual([
      { nodeId: " device-a ", registration },
      { nodeId: "device-a", registration },
    ]);
    expect(mocks.execute.mock.calls[0]?.[1]).toEqual({
      type: "apns.registrations.read",
      input: ["device-a", "missing"],
    });
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it("does not create storage for blank single or invalid-only batch inputs", async () => {
    await expect(loadApnsRegistration(" \t ", "/synthetic/unused")).resolves.toBeNull();
    await expect(
      loadApnsRegistrations(["", " \n", "x".repeat(257)], "/synthetic/unused"),
    ).resolves.toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it("retains the single lookup's nonempty overlong-ID behavior", async () => {
    const nodeId = "x".repeat(257);
    mocks.execute.mockResolvedValue(null);
    await expect(loadApnsRegistration(nodeId, "/synthetic/apns-a")).resolves.toBeNull();
    expect(mocks.execute.mock.calls[0]?.[1]).toEqual({
      type: "apns.registration.read",
      input: nodeId,
    });
  });
  it("captures the original inputs and relative state path before waiting", async () => {
    const ready = createDeferredCore<Map<string, ApnsRegistration>>();
    mocks.execute.mockReturnValue(ready.promise);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/synthetic/original");
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/ambient-a");
    const inputs = [" device-a ", "device-a"];
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
  });
  it("keeps a worker rejection without a synchronous fallback", async () => {
    const failure = new Error("invalid APNs registration row");
    mocks.execute.mockRejectedValue(failure);
    await expect(loadApnsRegistration("device-a", "/synthetic/apns-a")).rejects.toBe(failure);
    expect(mocks.native).not.toHaveBeenCalled();
  });
});
