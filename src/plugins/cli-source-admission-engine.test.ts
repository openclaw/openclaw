import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareCliDatabaseEngine } from "../cli/database-engine-selection.js";
import { ensureCliPluginRegistryLoaded } from "../cli/plugin-registry-loader.js";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../config/io.plugin-metadata.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as dbEngineConfig from "../infra/database-engine/config.js";
import {
  getDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as stateReadonly from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as stateWorkerStore from "../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../state/openclaw-state-worker-store.types.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as bundledDiscovery from "./bundled-discovery-state.js";
import {
  createPluginCliLoadSession,
  loadPluginCliDescriptors,
  resolvePluginCliRootOwnerIds,
} from "./cli-registry-loader.js";
import { registerPluginCliCommandsFromValidatedConfig } from "./cli.js";
import {
  publishPluginSourceAdmissionInDatabase,
  refreshPersistedInstalledPluginIndex,
} from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { nativeSize } from "./plugin-generation-artifact.admission.test-support.js";
import { readPluginMetadataStateRowsInDatabase } from "./plugin-metadata-state.kernel.js";
import { settlePluginNativeAdmissions } from "./plugin-native-admission-state.js";

const sqliteOnlySelection = Object.freeze({
  effectiveEngines: Object.freeze(resolveDatabaseFamilyEngines({})),
});
const pgEnvConn = (id: string) => ({ source: "env" as const, provider: "default" as const, id });

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    resetDatabaseEngineSelectionForTest();
    resetPluginLoaderTestStateForTest();
    clearRuntimeConfigSnapshot();
    bundledDiscovery.clearBundledDiscoveryModeMemo();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function createReceiptPluginFixture(pluginId = "receipt-memory", commandName = "memory") {
  const root = fs.realpathSync(dirs.make("openclaw-cli-receipt-engine-"));
  const stateDir = path.join(root, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const isMemory = commandName === "memory";
  const pluginDir = path.join(stateDir, "extensions", pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  const writeJson = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(pluginDir, name), JSON.stringify(value));
  writeJson("package.json", {
    name: pluginId,
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.js"] },
  });
  writeJson("openclaw.plugin.json", {
    id: pluginId,
    ...(isMemory ? { kind: "memory" } : {}),
    configSchema: { type: "object" },
  });
  const cmdJson = JSON.stringify(commandName);
  const entrySource = [
    `export default { id: ${JSON.stringify(pluginId)}, ${isMemory ? 'kind: "memory",' : ""} register(api) {`,
    `  api.registerCli(({ program }) => { const c = program.command(${cmdJson}); c.command("status").action(() => {}); c.command("index").action(() => {}); },`,
    `    { descriptors: [{ name: ${cmdJson}, description: "CLI", hasSubcommands: true }] }); } };`,
  ].join("\n");
  fs.writeFileSync(path.join(pluginDir, "index.js"), `${entrySource}\n`);
  fs.writeFileSync(path.join(pluginDir, "native.bin"), Buffer.alloc(nativeSize, "A"));
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    VITEST: "true",
  };
  const makeConfig = (database?: OpenClawConfig["database"]): OpenClawConfig => ({
    ...(database ? { database } : {}),
    plugins: {
      enabled: true,
      allow: [pluginId],
      ...(isMemory ? { slots: { memory: pluginId } } : {}),
      entries: { [pluginId]: { enabled: true } },
    },
  });
  return { stateDir, configPath, pluginId, env, makeConfig };
}

async function seedIndexedConfig(
  fixture: ReturnType<typeof createReceiptPluginFixture>,
  config: OpenClawConfig,
) {
  await withDatabaseEngineSelection(sqliteOnlySelection, () =>
    refreshPersistedInstalledPluginIndex({ config, env: fixture.env }),
  );
  await closeOpenClawStateDatabaseAsync();
  resetPluginLoaderTestStateForTest();
  bundledDiscovery.clearBundledDiscoveryModeMemo();
  fs.writeFileSync(fixture.configPath, JSON.stringify(config));
}

async function registerLazyCli(
  primary: string,
  session: ReturnType<typeof createPluginCliLoadSession>,
  skipPluginValidation = true,
) {
  const program = new Command();
  const registeredCfg = await registerPluginCliCommandsFromValidatedConfig(
    program,
    process.env,
    undefined,
    { mode: "lazy", primary, skipPluginValidation, session },
  );
  return { program, registeredCfg };
}

function writePostgresStateAnchor(stateDir: string) {
  const sqlitePath = path.join(stateDir, "state", "openclaw.sqlite");
  ["", "-wal", "-shm"].forEach((s) => fs.rmSync(`${sqlitePath}${s}`, { force: true }));
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  using anchor = openNodeSqliteDatabase(sqlitePath);
  anchor.exec(
    "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL); INSERT INTO openclaw_engine_anchor VALUES ('ported-store', 'postgres', 'openclaw_state_ported');",
  );
  return sqlitePath;
}

function expectAnchorOnly(sqlitePath: string) {
  using anchor = openNodeSqliteDatabase(sqlitePath, { readOnly: true });
  expect(anchor.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
    { name: "openclaw_engine_anchor" },
  ]);
}

async function expectPersistedReceipts(env: NodeJS.ProcessEnv, pluginId: string) {
  const persisted = await withDatabaseEngineSelection(sqliteOnlySelection, () =>
    withPluginCache(createPluginCache(), () => readPersistedInstalledPluginIndex({ env })),
  );
  const record = persisted?.plugins.find((plugin) => plugin.pluginId === pluginId);
  expect(Object.keys(record?.sourceAdmissions ?? {})).not.toHaveLength(0);
}

async function runWithWarnings(
  run: (session: ReturnType<typeof createPluginCliLoadSession>) => Promise<void>,
) {
  const warnings: string[] = [];
  const onWarning = (warning: Error | string) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("Plugin source receipt was not recorded")) {
      warnings.push(text);
    }
  };
  const cache = createPluginCache();
  const session = createPluginCliLoadSession(cache);
  process.on("warning", onWarning);
  try {
    await withPluginCache(cache, () => run(session));
  } finally {
    session.close();
    await settlePluginNativeAdmissions(cache);
    await retirePluginCache(cache, undefined, { waitForSettlement: true });
    process.off("warning", onWarning);
  }
  return warnings;
}

async function withRemoteSqliteBacking<T>(
  remoteEnv: NodeJS.ProcessEnv,
  fn: (remote: ReturnType<typeof openOpenClawStateDatabase>) => Promise<T> | T,
): Promise<T> {
  return await withDatabaseEngineSelection(sqliteOnlySelection, async () => {
    const remote = openOpenClawStateDatabase({ env: remoteEnv });
    try {
      return await fn(remote);
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

function mockPortedPostgresStateBacking(remoteEnv: NodeJS.ProcessEnv) {
  const capturedConnections: string[] = [];
  const realRead = stateReadonly.executeExistingOpenClawStateRead;
  vi.spyOn(stateReadonly, "executeExistingOpenClawStateRead").mockImplementation(
    async (options, command, readOptions) => {
      const selection = getDatabaseEngineSelection();
      if (selection?.effectiveEngines.state !== "postgres") {
        return realRead(options, command, readOptions);
      }
      capturedConnections.push(selection.postgres?.connection ?? "");
      if (command.type === "plugins.deferredMigrations.read") {
        return { ok: true as const, sourceAdmitted: true, type: command.type, pending: [] };
      }
      if (command.type !== "plugins.metadata.read") {
        return realRead(options, command, readOptions);
      }
      const rows = await withRemoteSqliteBacking(remoteEnv, (remote) =>
        readPluginMetadataStateRowsInDatabase(remote.db, command.input.stateKeys),
      );
      return { ok: true as const, sourceAdmitted: true, type: command.type, rows };
    },
  );
  const realWorkerOp = stateWorkerStore.runOpenClawStateWorkerOperation;
  vi.spyOn(stateWorkerStore, "runOpenClawStateWorkerOperation").mockImplementation(
    async (context, operation, options) => {
      if (context.databaseEngineSelection?.effectiveEngines.state !== "postgres") {
        return realWorkerOp(context, operation, options);
      }
      capturedConnections.push(context.databaseEngineSelection.postgres?.connection ?? "");
      return await withRemoteSqliteBacking(remoteEnv, (remote) => {
        const execute: DomainScope["execute"] = (async (command: {
          type: string;
          input: Parameters<typeof publishPluginSourceAdmissionInDatabase>[1];
        }) => {
          if (command.type !== "plugins.metadata.sourceAdmission.publish") {
            throw new Error(`Unexpected command: ${command.type}`);
          }
          return runOpenClawStateWriteTransaction(
            ({ db }) => publishPluginSourceAdmissionInDatabase(db, command.input),
            { database: remote, env: remoteEnv },
          );
        }) as DomainScope["execute"];
        return operation({ execute });
      });
    },
  );
  return capturedConnections;
}

describe("CLI plugin source receipt state-engine selection", () => {
  it.each(["status", "index"] as const)(
    "records CLI plugin source receipts against a ported PostgreSQL state store for memory %s",
    async (subcommand) => {
      const fixture = createReceiptPluginFixture();
      const remoteRoot = fs.realpathSync(dirs.make("openclaw-remote-pg-backing-"));
      const remoteEnv = { ...fixture.env, OPENCLAW_STATE_DIR: remoteRoot };
      const dsn = "postgresql://127.0.0.1:5432/openclaw_ported_test";
      const config = fixture.makeConfig({
        families: { state: { engine: "postgres" } },
        postgres: { connection: pgEnvConn("OPENCLAW_TEST_PG_DSN"), schemaPrefix: "openclaw" },
      });
      await seedIndexedConfig(fixture, config);
      fs.mkdirSync(path.join(remoteRoot, "state"), { recursive: true });
      fs.copyFileSync(
        path.join(fixture.stateDir, "state", "openclaw.sqlite"),
        path.join(remoteRoot, "state", "openclaw.sqlite"),
      );
      const anchorPath = writePostgresStateAnchor(fixture.stateDir);
      const capturedConnections = mockPortedPostgresStateBacking(remoteEnv);

      await withEnvAsync({ ...fixture.env, OPENCLAW_TEST_PG_DSN: dsn }, async () => {
        expect(await prepareCliDatabaseEngine(["node", "openclaw", "memory", subcommand])).toBe(
          false,
        );
        expect(getDatabaseEngineSelection()).toBeUndefined();

        const warnings = await runWithWarnings(async (session) => {
          const snapshot = await resolveConfigWidePluginMetadataSnapshotAsync({
            config,
            env: process.env,
          });
          expect(snapshot.index.plugins.map((p) => p.pluginId)).toContain(fixture.pluginId);
          expect(
            await loadPluginCliDescriptors({ cfg: config, primaryCommand: "memory", session }),
          ).toEqual([expect.objectContaining({ name: "memory" })]);
          expect(
            await resolvePluginCliRootOwnerIds({ cfg: config, primaryCommand: "memory", session }),
          ).toEqual([fixture.pluginId]);

          const { program, registeredCfg } = await registerLazyCli(
            "memory",
            session,
            subcommand === "status",
          );
          setRuntimeConfigSnapshot(registeredCfg, config);
          await ensureCliPluginRegistryLoaded({ scope: "memory", config: registeredCfg });
          await program.parseAsync(["memory", subcommand], { from: "user" });
        });

        expect(warnings).toEqual([]);
        expect(getDatabaseEngineSelection()).toBeUndefined();
        expect(new Set(capturedConnections)).toEqual(new Set([dsn]));
      });

      await expectPersistedReceipts(remoteEnv, fixture.pluginId);
      expectAnchorOnly(anchorPath);
    },
  );

  it("keeps SQLite state direct when another database family configures an unresolved PostgreSQL DSN", async () => {
    const fixture = createReceiptPluginFixture();
    const config = fixture.makeConfig({
      families: { state: { engine: "sqlite" }, workboard: { engine: "postgres" } },
      postgres: { connection: pgEnvConn("OPENCLAW_UNSET_WORKBOARD_DSN") },
    });
    await seedIndexedConfig(fixture, config);
    const resolveSelection = vi.spyOn(dbEngineConfig, "resolveDatabaseEngineSelection");

    await withEnvAsync({ ...fixture.env, OPENCLAW_UNSET_WORKBOARD_DSN: undefined }, async () => {
      const warnings = await runWithWarnings(async (session) => {
        await registerLazyCli("memory", session, true);
        await ensureCliPluginRegistryLoaded({ scope: "memory", config });
      });
      expect(warnings).toEqual([]);
      expect(resolveSelection).not.toHaveBeenCalled();
    });

    await expectPersistedReceipts(fixture.env, fixture.pluginId);
  });

  it("preserves caller-owned engine selection and avoids SQLite anchor warnings when PostgreSQL DSN is unresolved", async () => {
    const fixture = createReceiptPluginFixture("custom-cli", "custom");
    const anchorPath = writePostgresStateAnchor(fixture.stateDir);
    const config = fixture.makeConfig({
      families: { state: { engine: "postgres" } },
      postgres: { connection: pgEnvConn("OPENCLAW_MISSING_PG_DSN") },
    });
    fs.writeFileSync(fixture.configPath, JSON.stringify(config));

    await withEnvAsync({ ...fixture.env, OPENCLAW_MISSING_PG_DSN: undefined }, async () => {
      const warnings = await runWithWarnings(async (session) => {
        expect(
          await loadPluginCliDescriptors({ cfg: config, primaryCommand: "custom", session }),
        ).toEqual([expect.objectContaining({ name: "custom" })]);
        await registerLazyCli("logs", session, true);
      });
      expect(warnings).toEqual([]);
      expect(getDatabaseEngineSelection()).toBeUndefined();

      const resolveSelection = vi.spyOn(dbEngineConfig, "resolveDatabaseEngineSelection");
      const callerSelection = {
        effectiveEngines: resolveDatabaseFamilyEngines(config),
        postgres: { connection: "postgresql://127.0.0.1:5432/caller_owned" },
      };
      vi.spyOn(stateReadonly, "executeExistingOpenClawStateRead").mockResolvedValue(undefined);
      vi.spyOn(stateWorkerStore, "runOpenClawStateWorkerOperation").mockResolvedValue(undefined);
      const ownedWarnings = await withDatabaseEngineSelection(callerSelection, () =>
        runWithWarnings(async (session) => {
          expect(
            await loadPluginCliDescriptors({ cfg: config, primaryCommand: "custom", session }),
          ).toEqual([expect.objectContaining({ name: "custom" })]);
        }),
      );
      expect(ownedWarnings).toEqual([]);
      expect(resolveSelection).not.toHaveBeenCalled();
    });

    expectAnchorOnly(anchorPath);
  });

  it("persists CLI plugin source receipts normally on default SQLite state stores", async () => {
    const fixture = createReceiptPluginFixture();
    const config = fixture.makeConfig();
    await seedIndexedConfig(fixture, config);

    await withEnvAsync(fixture.env, async () => {
      const warnings = await runWithWarnings(async (session) => {
        const { program, registeredCfg } = await registerLazyCli("memory", session, false);
        await ensureCliPluginRegistryLoaded({ scope: "memory", config: registeredCfg });
        await program.parseAsync(["memory", "status"], { from: "user" });
      });
      expect(warnings).toEqual([]);
    });

    await expectPersistedReceipts(fixture.env, fixture.pluginId);
  });
});
