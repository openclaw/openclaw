import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import * as retry from "@openclaw/retry";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { writeFixtureJsonSync } from "../cli/cli-fixtures.test-support.js";
import { resolveDeferredPluginMigrationConfigPaths } from "../config/deferred-plugin-migration-config.js";
import { createConfigIO } from "../config/io.factory.js";
import { readConfigFileSnapshot, readConfigFileSnapshotWithPluginMetadata } from "../config/io.js";
import {
  readDeferredPluginMigrationsAsync,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { createSqliteReadOnlyWorkerError } from "../infra/sqlite-readonly-worker-protocol.js";
import { readBundledDiscoveryMode } from "../plugins/bundled-discovery-state.js";
import { readPersistedInstalledPluginIndexRowSync } from "../plugins/test-helpers/installed-plugin-index.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
  inspectAgentDatabaseAdmission,
} from "../state/agent-database-admission.js";
import * as databasePreflight from "../state/openclaw-database-preflight.js";
import {
  getActiveOpenClawStateDatabaseReadSnapshot,
  withArtifactPreservingStateReads,
} from "../state/openclaw-state-db-readonly.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "../state/openclaw-state-db-schema-migration-required.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createConfigPreflightSnapshotReader,
  readAdmittedConfigSnapshot,
} from "./config-preflight-snapshot.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

function writeConfig(
  home: string,
  config: Record<string, unknown> = { gateway: { mode: "local" }, plugins: { enabled: false } },
) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(home, ".openclaw/openclaw.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeFixtureJsonSync(configPath, config);
  return configPath;
}

async function retiredDatabase(revoke = false) {
  const databasePath = openOpenClawStateDatabase({ env: process.env }).path;
  await closeOpenClawStateDatabaseAsync();
  if (revoke) {
    revokeSqliteDatabaseAdmissionsForPath(databasePath);
  }
  return databasePath;
}

function databaseFamily(databasePath: string) {
  return ["", "-wal", "-shm"].map((suffix) => {
    const pathname = databasePath + suffix;
    return fs.existsSync(pathname) ? fs.readFileSync(pathname) : null;
  });
}

const metadataOptions = {
  allowCurrentPluginMetadata: false,
  includePluginMetadata: true,
  skipPluginValidation: false,
  observe: false,
} as const;
const readCore = () => readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });
const admissionRefusal = (
  options: Partial<Parameters<typeof createAgentDatabaseInspectionRefusal>[0]>,
) =>
  new AgentDatabaseAdmissionError(
    createAgentDatabaseInspectionRefusal({
      agentId: "requested",
      paths: ["/synthetic/agent.sqlite"],
      reason: "storage unavailable",
      ...options,
    }),
  );

it("reports completed plugin metadata work in startup admission traces", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    writeConfig(home);
    await withEnvAsync({ OPENCLAW_GATEWAY_STARTUP_TRACE: "1" }, async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await using snapshots = createConfigPreflightSnapshotReader();
        const result = await readAdmittedConfigSnapshot({
          env: process.env,
          readSnapshot: () =>
            snapshots.read({
              ...metadataOptions,
              purpose: "startup",
            }),
        });
        expect(result.snapshot.valid).toBe(true);
        const trace = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
        expect(trace).toMatch(/cli\.bootstrap\.admission\.plugin-metadata-completion [\d.]+ms/);
        expect(trace).toMatch(
          /cli\.bootstrap\.admission\.plugin-config [^\n]+ registrySnapshotMs=[\d.]+[^\n]+ indexPluginCount=\d+ manifestPluginCount=\d+/,
        );
      } finally {
        stderr.mockRestore();
      }
    });
  });
});

it("preserves a proven schema failure while completing plugin metadata", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    writeConfig(home, { gateway: { mode: "local" } });
    const pathname = await retiredDatabase(true);
    const database = new DatabaseSync(pathname);
    try {
      database.exec(
        "INSERT OR REPLACE INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES ('state.schema.contentVersion', '\"invalid\"', 1)",
      );
    } finally {
      database.close();
    }
    const before = fs.readFileSync(pathname);
    await expect(
      readConfigFileSnapshotWithPluginMetadata({
        observe: false,
        allowCurrentPluginMetadata: false,
      }),
    ).rejects.toMatchObject({
      name: "SqliteSchemaMismatchError",
      message: expect.stringContaining("Invalid shared state schema content version"),
    });
    expect(fs.readFileSync(pathname)).toEqual(before);
  });
});

it.each([
  "SQLite inspection",
  "initial config read",
  "full config read",
  "invalid authored JSON",
  "invalid include directive",
  "inspection with offline maintenance",
  "ownership mismatch",
  "wrapped ownership mismatch",
  "aggregate ownership mismatch",
  "pending inspection",
  "failed inspection",
  "proven integrity damage",
  "unavailable integrity check",
])("preserves failed %s during startup admission", async (phase) => {
  await withDoctorConfigPreflightHome(async (home) => {
    const configPath = writeConfig(home, {
      gateway: { mode: "local" },
      plugins: { enabled: false },
      ...(phase === "initial config read" ? { $include: "missing.json" } : {}),
      ...(phase === "invalid include directive" ? { $include: 42 } : {}),
    });
    if (phase === "invalid authored JSON") {
      fs.writeFileSync(configPath, "{ invalid authored JSON");
    }
    const inspectionFailure = createSqliteReadOnlyWorkerError(
      "failed while creating its private snapshot",
      "",
    );
    let failure: Error =
      phase === "inspection with offline maintenance"
        ? new AggregateError(
            [
              inspectionFailure,
              new OpenClawStateDatabaseSchemaMigrationRequiredError(
                "audit-events-v2",
                "/synthetic/state.sqlite",
              ),
            ],
            "startup inspection and maintenance failed",
          )
        : inspectionFailure;
    if (phase.includes("ownership mismatch")) {
      const mismatch = new AgentDatabaseAdmissionError(
        expectDefined(
          inspectAgentDatabaseAdmission({
            agentId: "requested",
            path: "/synthetic/agent.sqlite",
            metadata: { role: "agent", agentId: "actual" },
          }),
          "Expected an ownership mismatch",
        ),
      );
      failure =
        phase === "wrapped ownership mismatch"
          ? new Error("read admission failed", { cause: mismatch })
          : phase === "aggregate ownership mismatch"
            ? new AggregateError([inspectionFailure, mismatch], "read admission failed")
            : mismatch;
    } else if (phase === "pending inspection" || phase === "failed inspection") {
      failure = admissionRefusal({ pending: phase === "pending inspection" });
    } else if (phase === "proven integrity damage" || phase === "unavailable integrity check") {
      const integrity = new Error(
        "SQLite integrity_check failed",
        phase === "unavailable integrity check"
          ? { cause: Object.assign(new Error("storage unavailable"), { code: "EIO" }) }
          : undefined,
      );
      integrity.name = "SqliteIntegrityError";
      failure = admissionRefusal({ reason: integrity.message, cause: integrity });
    }
    const read = readAdmittedConfigSnapshot({
      env: process.env,
      readSnapshot: async () => {
        if (phase === "full config read") {
          const reader = createConfigIO({
            configPath,
            observe: false,
            fs: {
              ...fs,
              readFileSync() {
                throw Object.assign(new Error("configuration read failed: EIO"), { code: "EIO" });
              },
            },
          });
          return { snapshot: await reader.readConfigFileSnapshot() };
        }
        throw failure;
      },
    });
    if (phase === "invalid authored JSON" || phase === "invalid include directive") {
      await expect(read).resolves.toMatchObject({
        snapshot: { valid: false, issues: [{ errorCode: "CONFIG_SOURCE_INVALID" }] },
      });
    } else if (phase === "full config read") {
      await expect(read).rejects.toMatchObject({
        code: "CONFIG_READ_FAILED",
        message: expect.stringContaining("EIO"),
      });
    } else if (phase === "initial config read") {
      await expect(read).resolves.toMatchObject({
        snapshot: {
          valid: false,
          issues: [
            { errorCode: "CONFIG_READ_FAILED", message: expect.stringContaining("missing.json") },
          ],
        },
      });
    } else if (
      phase === "inspection with offline maintenance" ||
      phase === "proven integrity damage" ||
      phase.includes("ownership mismatch")
    ) {
      await expect(read).rejects.toMatchObject({ code: 78, cause: failure });
    } else {
      await expect(read).rejects.toBe(failure);
    }
  });
});

it("waits through temporary schema custody before reading startup configuration once", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const configPath = writeConfig(home);
    const databasePath = await retiredDatabase();
    const before = fs.readFileSync(databasePath);
    const marker = resolveGatewayStateOwnerPath(databasePath);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    writeFixtureJsonSync(marker, {
      pid: process.ppid,
      ownerId: "synthetic-schema-owner",
      processNamespace: readGatewayLockProcessNamespace(),
      createdAt: new Date().toISOString(),
      configPath,
      role: "sqlite-maintenance",
      stateOwnerKind: "schema",
    });
    const readSnapshot = vi.fn(async () => ({
      snapshot: await readCore(),
    }));
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const wait = vi.spyOn(retry, "sleepWithAbort").mockImplementation(async () => {
      expect(readSnapshot).not.toHaveBeenCalled();
      expect(fs.readFileSync(databasePath)).toEqual(before);
      if (wait.mock.calls.length === 1) {
        now.mockReturnValue(9_000);
      } else {
        fs.unlinkSync(marker);
        now.mockRestore();
      }
    });
    try {
      const result = await readAdmittedConfigSnapshot({ env: process.env, readSnapshot });
      expect(result.snapshot.valid).toBe(true);
      expect(wait).toHaveBeenCalledTimes(2);
      expect(readSnapshot).toHaveBeenCalledOnce();
      expect(fs.readFileSync(databasePath)).toEqual(before);
    } finally {
      wait.mockRestore();
      now.mockRestore();
      fs.rmSync(marker, { force: true });
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it("overlaps config discovery with schema admission and drains both before reporting refusal", async ({
  signal,
}) => {
  await withDoctorConfigPreflightHome(async (home) => {
    writeConfig(home);
    await retiredDatabase(true);
    const env = { ...process.env };
    const stateDir = env.OPENCLAW_STATE_DIR;
    const schemaEntered = createDeferred();
    const releaseSchema = createDeferred();
    const schemaRefused = createDeferred();
    const configEntered = createDeferred();
    const releaseConfig = createDeferred();
    const schemaFailure = new Error("synthetic schema admission refusal");
    const configFailure = new Error("synthetic config discovery failure");
    let snapshotLocation: string | undefined;
    let configRetainedSnapshot = false;
    const inspect = vi
      .spyOn(databasePreflight, "assertOpenClawDatabasesReady")
      .mockImplementation(async (options) => {
        schemaEntered.resolve();
        await releaseSchema.promise;
        expect(options.env.OPENCLAW_STATE_DIR).toBe(stateDir);
        schemaRefused.resolve();
        throw schemaFailure;
      });
    const guard = vi.fn(async () => true);
    const admission = readAdmittedConfigSnapshot({
      env,
      readSnapshot: async () => {
        snapshotLocation = getActiveOpenClawStateDatabaseReadSnapshot({ env })?.location;
        env.OPENCLAW_STATE_DIR = path.join(home, "changed-during-config-read");
        configEntered.resolve();
        await releaseConfig.promise;
        configRetainedSnapshot = snapshotLocation !== undefined && fs.existsSync(snapshotLocation);
        throw configFailure;
      },
      beforeStatePreparation: guard,
    });
    const waitFor = (gate: Promise<void>, message: string) =>
      withinTest(awaitGateBeforeSettlement(gate, admission, message), signal);
    try {
      await waitFor(schemaEntered.promise, "Schema admission never began");
      releaseSchema.resolve();
      await waitFor(
        configEntered.promise,
        "Config discovery did not start while schema admission was pending",
      );
      await withinTest(schemaRefused.promise, signal);
      const retainedLocation = expectDefined(snapshotLocation, "Expected the admitted snapshot");
      expect(fs.existsSync(retainedLocation)).toBe(true);
      expect(guard).not.toHaveBeenCalled();
      releaseConfig.resolve();
      await expect(admission).rejects.toBe(schemaFailure);
      expect(configRetainedSnapshot).toBe(true);
      expect(fs.existsSync(retainedLocation)).toBe(false);
    } finally {
      releaseSchema.resolve();
      releaseConfig.resolve();
      await admission.catch(() => undefined);
      inspect.mockRestore();
    }
  });
});

it("shares startup validation and discovery reads, then releases them before readiness guards", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    writeConfig(home);
    const options = { env: process.env };
    const databasePath = await retiredDatabase(true);
    const writer = new DatabaseSync(databasePath);
    const family = () => databaseFamily(databasePath);
    const readIndex = () =>
      readPersistedInstalledPluginIndexRowSync({ env: process.env })?.value_json;
    try {
      const setMetadata = writer.prepare(
        `INSERT INTO config_machine_state(state_key, value_json, updated_at_ms)
           VALUES ('plugins.bundledDiscovery', ?, 1), ('plugins.installedIndex', ?, 1)
           ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json`,
      );
      setMetadata.run('"compat"', '{"generation":"before"}');
      const before = family();
      let afterWrite: ReturnType<typeof family> | undefined;
      const validations: Array<string | undefined> = [];
      const result = await readAdmittedConfigSnapshot({
        env: process.env,
        validateConfig: () => {
          validations.push(readIndex());
          expect(readBundledDiscoveryMode(options)).toBe("compat");
        },
        readSnapshot: async () => {
          const snapshot = await readCore();
          expect(readBundledDiscoveryMode(options)).toBe("compat");
          expect(family()).toEqual(before);
          // A different owner commits between the two metadata reads.
          setMetadata.run('"allowlist"', '{"generation":"after"}');
          afterWrite = family();
          expect(readIndex()).toBe('{"generation":"before"}');
          expect(family()).toEqual(afterWrite);
          return { snapshot };
        },
        beforeStatePreparation: async () => {
          expect(readBundledDiscoveryMode(options)).toBe("allowlist");
          expect(readIndex()).toBe('{"generation":"after"}');
          return true;
        },
      });
      expect(result.snapshot.valid).toBe(true);
      expect(validations).toEqual(['{"generation":"before"}', '{"generation":"before"}']);
      expect(family()).toEqual(afterWrite);
    } finally {
      writer.close();
      closeOpenClawStateDatabaseForTest();
    }
  });
});

it.each([
  { name: "preserves pending-plugin inputs through Doctor preflight", legacyIdentity: false },
  {
    name: "refuses startup with a legacy identity and leaves pending obligations intact",
    legacyIdentity: true,
  },
])("$name", async ({ legacyIdentity }) => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
    const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const source = {
      gateway: { mode: "local", port: 18991 },
      plugins: legacyIdentity
        ? {
            enabled: false,
            entries: { canvas: { enabled: false, config: { host: { enabled: false } } } },
          }
        : { entries: { canvas: { enabled: true } } },
      ...(!legacyIdentity
        ? { canvasHost: { enabled: true, root: path.join(home, "legacy-canvas") } }
        : {}),
    };
    const activeRaw = `${JSON.stringify(source, null, 2)}\n`;
    const backupRaw = JSON.stringify({
      gateway: { mode: "local", port: 18789 },
      plugins: { enabled: false },
    });
    fs.writeFileSync(configPath, activeRaw);
    fs.writeFileSync(`${configPath}.bak`, backupRaw);
    const initial = await readCore();
    expect(initial.valid).toBe(legacyIdentity);

    await recordDeferredPluginMigrations({
      env: process.env,
      pending: [
        {
          pluginId: "canvas",
          reason: "The configured plugin is not installed.",
          command: "openclaw doctor --fix",
          ...resolveDeferredPluginMigrationConfigPaths({
            config: initial.sourceConfig,
            pluginId: "canvas",
            compatibilityMigrationPaths: ["canvasHost"],
          }),
        },
      ],
      resolvedPluginIds: [],
    });
    expect((await readConfigFileSnapshot({ observe: false })).valid).toBe(legacyIdentity);
    await closeOpenClawStateDatabaseAsync();
    const identityPath = path.join(stateDir, "identity", "device.json");
    const identityRaw = '{"retiredIdentity":"leave for Doctor"}\n';
    if (legacyIdentity) {
      fs.mkdirSync(path.dirname(identityPath), { recursive: true });
      fs.writeFileSync(identityPath, identityRaw);
    }
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const before = databaseFamily(databasePath);
    if (legacyIdentity) {
      await expect(
        runStartupConfigPreflight({ gateway: true, observe: false }),
      ).rejects.toMatchObject({
        code: 78,
        message: expect.stringContaining("Legacy client credentials require migration"),
      });
      expect(fs.readFileSync(identityPath, "utf8")).toBe(identityRaw);
    } else {
      await using snapshots = createConfigPreflightSnapshotReader();
      const result = await withArtifactPreservingStateReads(async () =>
        snapshots.read({
          ...metadataOptions,
          purpose: "doctor",
          deferredPluginMigrations: await readDeferredPluginMigrationsAsync(),
        }),
      );
      expect(result.snapshot).toMatchObject({
        valid: true,
        hash: initial.hash,
        raw: activeRaw,
        sourceConfig: source,
        config: { gateway: { port: 18991 } },
      });
      expect(result.snapshot.config).not.toHaveProperty("canvasHost");
    }
    expect(fs.readFileSync(configPath, "utf8")).toBe(activeRaw);
    expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe(backupRaw);
    expect(databaseFamily(databasePath)).toEqual(before);
  });
});
