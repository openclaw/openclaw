import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedMacNodeWorkerProofState } from "../../scripts/lib/mac-node-worker-proof-state.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readDeviceAuthTokenForTest } from "../infra/device-auth-store.test-support.js";
import { generateStoredDeviceIdentity } from "../infra/device-identity-store.js";
import * as identityStore from "../infra/device-identity.js";
import { resetExecApprovalsMigrationGateForTest } from "../infra/exec-approvals-migration-gate.js";
import { readExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import * as authMigration from "../infra/state-migrations.device-auth.js";
import * as identityMigration from "../infra/state-migrations.device-identity.js";
import * as execMigration from "../infra/state-migrations.exec-approvals.js";
import { createDeferredCore } from "../shared/deferred.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import * as stateDb from "../state/openclaw-state-db.js";

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

type MigrationContext = {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  doctorOnlyStateMigrations: true;
};
function repairWith<T>(
  detect: (context: MigrationContext) => T,
  migrate: (context: MigrationContext & { detected: T }) => Promise<{ warnings: string[] }>,
) {
  return (env: NodeJS.ProcessEnv, stateDir: string) => {
    const context: MigrationContext = { env, stateDir, doctorOnlyStateMigrations: true };
    return migrate({ ...context, detected: detect(context) });
  };
}
const makeIdentity = () => generateStoredDeviceIdentity(1_700_000_000_000);
const retiredStores = [
  {
    name: "device auth",
    relativePath: "identity/device-auth.json",
    contents: () => ({
      version: 1,
      deviceId: "device-1",
      tokens: { node: { token: "test-legacy-token", scopes: [], updatedAtMs: 10 } },
    }),
    repair: repairWith(authMigration.detectLegacyDeviceAuth, authMigration.migrateLegacyDeviceAuth),
  },
  {
    name: "device identity",
    relativePath: "identity/device.json",
    contents: () => ({ version: 1, ...makeIdentity() }),
    repair: repairWith(
      identityMigration.detectLegacyDeviceIdentity,
      identityMigration.migrateLegacyDeviceIdentity,
    ),
  },
  {
    name: "exec approvals",
    relativePath: "exec-approvals.json",
    contents: () => ({ version: 1, defaults: { security: "deny" }, agents: {} }),
    repair: repairWith(
      execMigration.detectLegacyExecApprovals,
      execMigration.migrateLegacyExecApprovals,
    ),
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
      stateDb.closeOpenClawStateDatabaseForTest();
      resetExecApprovalsMigrationGateForTest();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      cleanup();
    });
  });

  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  const databasePath = () => path.join(stateDir, "state", "openclaw.sqlite");
  const identity = () => identityStore.loadDeviceIdentityIfPresent({ env });
  const approvals = (
    db: Parameters<typeof readExecApprovalsConfigRow>[0] = stateDb.openOpenClawStateDatabase({
      env,
    }).db,
  ) => readExecApprovalsConfigRow(db);
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
      expect(approvals()).toBeUndefined();
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
      const contents = store?.contents() ?? { pending: true };
      const { sourcePath, raw } = writeSource(relativePath, contents);
      // Both entrypoints must reject legacy state; the shared readiness owner owns the matrix.
      const start = store?.name === "device identity" ? runNodeHostWorker : run;

      await expect(start()).rejects.toThrow(/openclaw doctor --fix/);

      expect(fs.readFileSync(sourcePath, "utf8")).toBe(raw);
      expectUnprepared();
      const { db } = stateDb.openOpenClawStateDatabase({ env });
      for (const table of ["device_identities", "device_auth_tokens"]) {
        expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      expect(approvals(db)).toBeUndefined();

      if (!store) {
        return;
      }
      expect(await store.repair(env, stateDir)).toMatchObject({ warnings: [] });
      expect(fs.existsSync(sourcePath)).toBe(false);
      await expectAdmission(start);
      expect(fixture.prepare).toHaveBeenCalledOnce();
      if (store.name === "device auth") {
        expect(readDeviceAuthTokenForTest({ deviceId: "device-1", role: "node", env })?.token).toBe(
          "test-legacy-token",
        );
      } else if (store.name === "device identity") {
        expect(contents).toMatchObject({ deviceId: identity()?.deviceId });
      } else {
        expect(JSON.parse(approvals(db)!.raw_json)).toMatchObject({
          defaults: { security: "deny" },
        });
      }
    },
  );

  it.each(["managed", "canonical", "native"] as const)(
    "admits %s state without replacing its authority",
    async (mode) => {
      if (mode === "managed") {
        stateDb.openOpenClawStateDatabase({ env });
        stateDb.closeOpenClawStateDatabaseForTest();
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
      } else {
        const expected = makeIdentity();
        seedMacNodeWorkerProofState(databasePath());
        const seed = new DatabaseSync(databasePath());
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
        await expectAdmission();
        expect(identity()?.deviceId).toBe(expected.deviceId);
        const verified = new DatabaseSync(databasePath(), { readOnly: true });
        try {
          expect(verified.prepare("PRAGMA user_version").get()).toEqual({
            user_version: OPENCLAW_STATE_SCHEMA_VERSION,
          });
          expect(JSON.parse(approvals(verified)!.raw_json)).toMatchObject({
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
