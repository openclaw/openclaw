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
import { createDeferredCore } from "../shared/deferred.js";
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
  initializeSqlite: vi.fn<() => Promise<void>>().mockResolvedValue(),
}));

vi.mock("../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/bun-sqlite-library.js")>()),
  initializeSqliteRuntimeCapabilities: fixture.initializeSqlite,
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

const entrypoints = [
  { name: "node runner", run: () => runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 }) },
  { name: "JSONL worker", run: runNodeHostWorker },
];
const run = entrypoints[0]!.run;

describe("node-host state readiness", () => {
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
    fixture.initializeSqlite.mockReset().mockResolvedValue();
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

  it.each(entrypoints)(
    "$name awaits SQLite admission without creating identity or exec authority",
    async ({ run: start }) => {
      const { env, stateDir } = useStateDir();
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
        expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
        expect(fixture.configure).not.toHaveBeenCalled();
        expect(fixture.prepare).not.toHaveBeenCalled();
      } finally {
        decided.resolve();
        await outcome;
      }
      expect(fixture.prepare).toHaveBeenCalledOnce();
      expect(loadDeviceIdentityIfPresent({ env })).toBeNull();
      expect(readExecApprovalsConfigRow(openOpenClawStateDatabase({ env }).db)).toBeUndefined();
    },
  );

  it.each([
    ...retiredStores.map((store) => ({ relativePath: store.relativePath, store })),
    ...[
      "identity/device.json.doctor-importing",
      "identity/device.json.native-importing",
      "exec-approvals.json.doctor-importing",
    ].map((relativePath) => ({ relativePath, store: undefined })),
  ])(
    "leaves $relativePath for Doctor before preparing capabilities",
    async ({ relativePath, store }) => {
      const { env, stateDir } = useStateDir();
      const contents = store?.contents() ?? { pending: true };
      const { sourcePath, raw } = writeSource(stateDir, relativePath, contents);
      // Both entrypoints must reject legacy state; the shared readiness owner owns the matrix.
      const start = store?.name === "device identity" ? runNodeHostWorker : run;

      await expect(start()).rejects.toThrow(/openclaw doctor --fix/);

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

      if (!store) {
        return;
      }
      const repaired = await store.repair(env, stateDir);
      expect(repaired.warnings).toEqual([]);
      expect(fs.existsSync(sourcePath)).toBe(false);
      await expect(start()).rejects.toBe(fixture.admitted);
      expect(fixture.prepare).toHaveBeenCalledOnce();
      if (store.name === "device auth") {
        expect(readDeviceAuthTokenForTest({ deviceId: "device-1", role: "node", env })?.token).toBe(
          "test-legacy-token",
        );
      } else if (store.name === "device identity") {
        expect(contents).toMatchObject({
          deviceId: loadDeviceIdentityIfPresent({ env })?.deviceId,
        });
      } else {
        expect(JSON.parse(readExecApprovalsConfigRow(db)!.raw_json)).toMatchObject({
          defaults: { security: "deny" },
        });
      }
    },
  );

  it.each(["managed", "canonical", "native"] as const)(
    "admits %s state without replacing its authority",
    async (mode) => {
      const { env, stateDir } = useStateDir();
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      if (mode === "managed") {
        openOpenClawStateDatabase({ env });
        closeOpenClawStateDatabaseForTest();
        await expect(withExistingOpenClawStateSchema({ path: databasePath }, run)).rejects.toBe(
          fixture.admitted,
        );
      } else if (mode === "canonical") {
        const canonical = loadOrCreateDeviceIdentity({ env });
        const { sourcePath, raw } = writeSource(stateDir, "identity/device.json", {
          version: 1,
          ...generateStoredDeviceIdentity(1_700_000_000_000),
        });
        await expect(run()).rejects.toBe(fixture.admitted);
        expect(fs.readFileSync(sourcePath, "utf8")).toBe(raw);
        expect(loadDeviceIdentityIfPresent({ env })).toEqual(canonical);
      } else {
        const expected = generateStoredDeviceIdentity(1_700_000_000_000);
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
      }
      expect(fixture.prepare).toHaveBeenCalledOnce();
    },
  );
});
