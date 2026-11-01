import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedMacNodeWorkerProofState } from "../../scripts/lib/mac-node-worker-proof-state.mjs";
import { ClientCredentialMigrationRequiredError } from "../infra/client-credential-readiness.js";
import { loadDeviceAuthToken as readDeviceAuthTokenForTest } from "../infra/device-auth-store.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import * as identityStore from "../infra/device-identity.js";
import {
  ExecApprovalsMigrationRequiredError,
  resetExecApprovalsMigrationGateForTest,
} from "../infra/exec-approvals-migration-gate.js";
import { readExecApprovalsConfigRow as approvals } from "../infra/exec-approvals-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";

const fixture = vi.hoisted(() => ({
  admitted: new Error("node runtime preparation reached"),
  configure: vi.fn(async () => ({ version: 1, nodeId: "test-node" })),
  prepare: vi.fn(),
  initializeSqlite: vi.fn<() => Promise<void>>().mockResolvedValue(),
}));

vi.mock("../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/bun-sqlite-library.js")>()),
  initializeSqliteRuntimeCapabilities: fixture.initializeSqlite,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => ({}),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));
vi.mock("./config.js", () => ({
  loadNodeHostConfig: async () => null,
  configureNodeHost: fixture.configure,
}));
vi.mock("../infra/machine-name.js", () => ({ getMachineDisplayName: async () => "test-node" }));
vi.mock("./runtime.js", () => ({ prepareNodeHostRuntime: fixture.prepare }));

import { runNodeHost } from "./runner.js";
import { runNodeHostWorker } from "./worker.js";

const makeIdentity = () => generateStoredDeviceIdentity(1_700_000_000_000);

const entrypoints = [
  { name: "node runner", run: () => runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 }) },
  { name: "JSONL worker", run: runNodeHostWorker },
];
const run = entrypoints[0]!.run;

describe("node-host state readiness", () => {
  const tempDirs = useStateDatabaseTempDirs();
  afterEach(async () => {
    await stateDb.closeOpenClawStateDatabaseAsync();
    resetExecApprovalsMigrationGateForTest();
    vi.unstubAllEnvs();
  });

  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  const databasePath = () => path.join(stateDir, "state", "openclaw.sqlite");
  const identity = () => identityStore.loadDeviceIdentityIfPresent({ env });
  const expectAdmission = (start = run) => expect(start()).rejects.toBe(fixture.admitted);
  const expectUnprepared = () => {
    expect(fixture.configure).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fixture.prepare.mockRejectedValue(fixture.admitted);
    fixture.initializeSqlite.mockReset().mockResolvedValue();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stateDir = fs.realpathSync(tempDirs.make("openclaw-node-readiness-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  function writeSource(relativePath: string, contents: unknown) {
    const sourcePath = path.join(stateDir, relativePath);
    const raw = `${JSON.stringify(contents)}\n`;
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, raw);
    return { sourcePath, raw };
  }

  it.each(entrypoints)(
    "$name awaits SQLite admission without creating identity or exec authority",
    async ({ run: start }) => {
      const entered = createDeferredCore();
      const decided = createDeferredCore();
      fixture.initializeSqlite.mockImplementationOnce(() => {
        entered.resolve();
        return decided.promise;
      });
      const starting = start();
      const outcome = expect(starting).rejects.toBe(fixture.admitted);
      try {
        await Promise.race([entered.promise, starting]);
        expect(fs.existsSync(databasePath())).toBe(false);
        expectUnprepared();
      } finally {
        decided.resolve();
        await outcome;
      }
      expect(fixture.prepare).toHaveBeenCalledOnce();
      expect(identity()).toBeNull();
      expect(fs.existsSync(databasePath())).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "client", "credentials.sqlite"))).toBe(false);
    },
  );

  it.each([
    "identity/device-auth.json",
    "identity/device.json",
    "exec-approvals.json",
    "identity/device.json.doctor-importing",
    "identity/device.json.native-importing",
    "exec-approvals.json.doctor-importing",
  ])(
    "prepares valid %s before capabilities and preserves invalid sources",
    async (relativePath) => {
      const auth = relativePath === "identity/device-auth.json";
      const device = relativePath === "identity/device.json";
      const approvalsFile = relativePath === "exec-approvals.json";
      const contents = auth
        ? {
            version: 1,
            deviceId: "device-1",
            tokens: { node: { token: "test-legacy-token", scopes: [], updatedAtMs: 10 } },
          }
        : device
          ? { version: 1, ...makeIdentity() }
          : approvalsFile
            ? { version: 1, defaults: { security: "deny" }, agents: {} }
            : { pending: true };
      const { sourcePath, raw } = writeSource(relativePath, contents);
      const start = device ? runNodeHostWorker : run;
      if (!auth && !device && !approvalsFile) {
        await expect(start()).rejects.toThrow(
          relativePath === "exec-approvals.json.doctor-importing"
            ? ExecApprovalsMigrationRequiredError
            : ClientCredentialMigrationRequiredError,
        );
        expect(fs.readFileSync(sourcePath)).toEqual(Buffer.from(raw));
        expect(fs.existsSync(databasePath())).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "client", "credentials.sqlite"))).toBe(false);
        expectUnprepared();
        return;
      }
      await expectAdmission(start);
      if (approvalsFile) {
        expect(fs.existsSync(sourcePath)).toBe(false);
      } else {
        expect(fs.readFileSync(sourcePath, "utf8")).toBe(raw);
      }
      const { db } = stateDb.openOpenClawStateDatabase({ env });
      expect(fixture.prepare).toHaveBeenCalledOnce();
      if (auth) {
        expect(
          (await readDeviceAuthTokenForTest({ deviceId: "device-1", role: "node", env }))?.token,
        ).toBe("test-legacy-token");
      } else if (device) {
        expect(contents).toMatchObject({ deviceId: identity()?.deviceId });
      } else {
        expect(JSON.parse(approvals(db)!.raw_json)).toMatchObject({
          defaults: { security: "deny" },
        });
      }
    },
  );

  it.each(["managed", "canonical"] as const)(
    "admits %s state without replacing its authority",
    async (mode) => {
      if (mode === "managed") {
        stateDb.openOpenClawStateDatabase({ env });
        await stateDb.closeOpenClawStateDatabaseAsync();
        await expect(withExistingOpenClawStateSchema({ path: databasePath() }, run)).rejects.toBe(
          fixture.admitted,
        );
      } else if (mode === "canonical") {
        const canonical = identityStore.loadOrCreateDeviceIdentity({ env });
        const { sourcePath, raw } = writeSource("identity/device.json", {
          version: 1,
          ...makeIdentity(),
        });
        await expectAdmission();
        expect(fs.readFileSync(sourcePath, "utf8")).toBe(raw);
        expect(identity()).toEqual(canonical);
      }
      expect(fixture.prepare).toHaveBeenCalledOnce();
    },
  );

  it("automatically migrates native identity and policy before startup", async () => {
    const nativeIdentity = makeIdentity();
    seedMacNodeWorkerProofState(databasePath());
    const seed = new DatabaseSync(databasePath());
    let nativePolicy: string;
    try {
      seed
        .prepare("INSERT INTO device_identities VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          "primary",
          nativeIdentity.deviceId,
          nativeIdentity.publicKeyPem,
          nativeIdentity.privateKeyPem,
          nativeIdentity.createdAtMs,
          nativeIdentity.createdAtMs,
        );
      nativePolicy = approvals(seed)!.raw_json;
    } finally {
      seed.close();
    }
    await expectAdmission();
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(identity()).toEqual({
      deviceId: nativeIdentity.deviceId,
      publicKeyPem: nativeIdentity.publicKeyPem,
      privateKeyPem: nativeIdentity.privateKeyPem,
    });
    const { db } = stateDb.openOpenClawStateDatabase({ env });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(approvals(db)!.raw_json).toBe(nativePolicy);
  });

  it("refuses malformed selected Gateway state without replacing it", async () => {
    const selectedPath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(selectedPath), { recursive: true });
    fs.writeFileSync(selectedPath, "synthetic selected Gateway state sentinel");
    await expect(run()).rejects.toThrow();
    expect(fs.readFileSync(selectedPath, "utf8")).toBe("synthetic selected Gateway state sentinel");
    expect(fixture.configure).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDir, "client", "credentials.sqlite"))).toBe(false);
  });
});
