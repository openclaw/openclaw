import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedMacNodeWorkerProofState } from "../../scripts/lib/mac-node-worker-proof-state.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readDeviceAuthTokenForTest } from "../infra/device-auth-store.test-support.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "../infra/device-identity.js";
import { resetExecApprovalsMigrationGateForTest } from "../infra/exec-approvals-migration-gate.js";
import { readExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import {
  detectLegacyDeviceAuth,
  migrateLegacyDeviceAuth,
} from "../infra/state-migrations.device-auth.js";
import {
  detectLegacyDeviceIdentity,
  migrateLegacyDeviceIdentity,
} from "../infra/state-migrations.device-identity.js";
import {
  detectLegacyExecApprovals,
  migrateLegacyExecApprovals,
} from "../infra/state-migrations.exec-approvals.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";

const fixture = vi.hoisted(() => ({
  admitted: new Error("node runtime preparation reached"),
  configure: vi.fn(async () => ({ version: 1, nodeId: "test-node" })),
  prepare: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => ({}),
}));
vi.mock("./config.js", () => ({
  loadNodeHostConfig: async () => null,
  configureNodeHost: fixture.configure,
}));
vi.mock("../infra/machine-name.js", () => ({ getMachineDisplayName: async () => "test-node" }));
vi.mock("./runtime.js", () => ({ prepareNodeHostRuntime: fixture.prepare }));

import { runNodeHost } from "./runner.js";
import { runNodeHostWorker } from "./worker.js";

const retiredStores = [
  {
    name: "device auth",
    relativePath: "identity/device-auth.json",
    contents: () => ({
      version: 1,
      deviceId: "device-1",
      tokens: { node: { token: "test-legacy-token", scopes: [], updatedAtMs: 10 } },
    }),
    repair: async (env: NodeJS.ProcessEnv, stateDir: string) =>
      await migrateLegacyDeviceAuth({
        detected: detectLegacyDeviceAuth({ stateDir, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
      }),
  },
  {
    name: "device identity",
    relativePath: "identity/device.json",
    contents: () => ({ version: 1, ...generateStoredDeviceIdentity(1_700_000_000_000) }),
    repair: async (env: NodeJS.ProcessEnv, stateDir: string) =>
      await migrateLegacyDeviceIdentity({
        detected: detectLegacyDeviceIdentity({ stateDir, env, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
        doctorOnlyStateMigrations: true,
      }),
  },
  {
    name: "exec approvals",
    relativePath: "exec-approvals.json",
    contents: () => ({ version: 1, defaults: { security: "deny" }, agents: {} }),
    repair: async (env: NodeJS.ProcessEnv, stateDir: string) =>
      await migrateLegacyExecApprovals({
        detected: detectLegacyExecApprovals({ stateDir, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
      }),
  },
];

describe.each([
  { name: "node runner", run: () => runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 }) },
  { name: "JSONL worker", run: runNodeHostWorker },
])("$name state readiness", ({ run }) => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      resetExecApprovalsMigrationGateForTest();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      cleanup();
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fixture.prepare.mockRejectedValue(fixture.admitted);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  function useStateDir() {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-node-readiness-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    return { stateDir, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  }

  function writeSource(stateDir: string, relativePath: string, contents: unknown) {
    const sourcePath = path.join(stateDir, relativePath);
    const raw = `${JSON.stringify(contents)}\n`;
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, raw);
    return { sourcePath, raw };
  }

  it.each(retiredStores)("leaves $name for Doctor before preparing capabilities", async (store) => {
    const { env, stateDir } = useStateDir();
    const contents = store.contents();
    const { sourcePath, raw } = writeSource(stateDir, store.relativePath, contents);

    await expect(run()).rejects.toThrow(/openclaw doctor --fix/);

    expect(fs.readFileSync(sourcePath, "utf8")).toBe(raw);
    expect(fixture.configure).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
    const { db } = openOpenClawStateDatabase({ env });
    expect(db.prepare("SELECT count(*) AS count FROM device_identities").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT count(*) AS count FROM device_auth_tokens").get()).toEqual({
      count: 0,
    });
    expect(readExecApprovalsConfigRow(db)).toBeUndefined();

    const repaired = await store.repair(env, stateDir);
    expect(repaired.warnings).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    await expect(run()).rejects.toBe(fixture.admitted);
    expect(fixture.prepare).toHaveBeenCalledOnce();
    if (store.name === "device auth") {
      expect(readDeviceAuthTokenForTest({ deviceId: "device-1", role: "node", env })?.token).toBe(
        "test-legacy-token",
      );
    } else if (store.name === "device identity") {
      expect(contents).toMatchObject({ deviceId: loadDeviceIdentityIfPresent({ env })?.deviceId });
    } else {
      expect(JSON.parse(readExecApprovalsConfigRow(db)!.raw_json)).toMatchObject({
        defaults: { security: "deny" },
      });
    }
  });

  it.each([
    "identity/device.json.doctor-importing",
    "identity/device.json.native-importing",
    "exec-approvals.json.doctor-importing",
  ])("leaves pending claim %s untouched before creating authority", async (relativePath) => {
    const { env, stateDir } = useStateDir();
    const { sourcePath, raw } = writeSource(stateDir, relativePath, { pending: true });

    await expect(run()).rejects.toThrow(/openclaw doctor --fix/);

    expect(fs.readFileSync(sourcePath, "utf8")).toBe(raw);
    expect(fixture.configure).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
    const { db } = openOpenClawStateDatabase({ env });
    expect(db.prepare("SELECT count(*) AS count FROM device_identities").get()).toEqual({
      count: 0,
    });
    expect(readExecApprovalsConfigRow(db)).toBeUndefined();
  });

  it("admits fresh state without creating a device identity or exec authority", async () => {
    const { env } = useStateDir();

    await expect(run()).rejects.toBe(fixture.admitted);

    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(loadDeviceIdentityIfPresent({ env })).toBeNull();
    expect(readExecApprovalsConfigRow(openOpenClawStateDatabase({ env }).db)).toBeUndefined();
  });

  it("admits managed runtime state without attempting schema bootstrap", async () => {
    const { env, stateDir } = useStateDir();
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");

    await expect(withExistingOpenClawStateSchema({ path: databasePath }, run)).rejects.toBe(
      fixture.admitted,
    );

    expect(fixture.prepare).toHaveBeenCalledOnce();
  });

  it("keeps the canonical identity authoritative and leaves divergent retired bytes for Doctor", async () => {
    const { env, stateDir } = useStateDir();
    const canonical = loadOrCreateDeviceIdentity({ env });
    const { sourcePath, raw } = writeSource(stateDir, "identity/device.json", {
      version: 1,
      ...generateStoredDeviceIdentity(1_700_000_000_000),
    });

    await expect(run()).rejects.toBe(fixture.admitted);

    expect(fs.readFileSync(sourcePath, "utf8")).toBe(raw);
    expect(loadDeviceIdentityIfPresent({ env })).toEqual(canonical);
  });

  it("completes native version-zero bootstrap before read-only identity admission", async () => {
    const { env, stateDir } = useStateDir();
    const expected = generateStoredDeviceIdentity(1_700_000_000_000);
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    seedMacNodeWorkerProofState(databasePath);
    const seed = new DatabaseSync(databasePath);
    seed
      .prepare("INSERT INTO device_identities VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "primary",
        expected.deviceId,
        expected.publicKeyPem,
        expected.privateKeyPem,
        expected.createdAtMs,
        expected.createdAtMs,
      );
    seed.close();

    await expect(run()).rejects.toBe(fixture.admitted);

    expect(loadDeviceIdentityIfPresent({ env })?.deviceId).toBe(expected.deviceId);
    const verified = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(verified.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(JSON.parse(readExecApprovalsConfigRow(verified)!.raw_json)).toMatchObject({
        defaults: { security: "deny" },
      });
    } finally {
      verified.close();
    }
  });
});
