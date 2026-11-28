import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Command } from "commander";
import pg from "pg";
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
import { dropPostgresTestSchemas } from "../infra/postgres-sync/schema-cleanup.test-support.js";
import * as stateReadonly from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
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
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { nativeSize } from "./plugin-generation-artifact.admission.test-support.js";
import { settlePluginNativeAdmissions } from "./plugin-native-admission-state.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
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
  fs.writeFileSync(
    path.join(pluginDir, "index.js"),
    `export default { id: ${JSON.stringify(pluginId)}, ${isMemory ? 'kind: "memory",' : ""} register(api) {\n` +
      `  api.registerCli(({ program }) => { const c = program.command(${cmdJson}); c.command("status").action(() => {}); c.command("index").action(() => {}); },\n` +
      `    { descriptors: [{ name: ${cmdJson}, description: "CLI", hasSubcommands: true }] }); } };\n`,
  );
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

async function seedSqliteIndexedConfig(
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

async function expectPersistedReceipts(
  selection: Parameters<typeof withDatabaseEngineSelection>[0],
  env: NodeJS.ProcessEnv,
  pluginId: string,
) {
  const persisted = await withDatabaseEngineSelection(selection, () =>
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

async function runMemorySubcommandFlow(
  config: OpenClawConfig,
  pluginId: string,
  subcommand: "status" | "index",
) {
  expect(await prepareCliDatabaseEngine(["node", "openclaw", "memory", subcommand])).toBe(false);
  expect(getDatabaseEngineSelection()).toBeUndefined();
  const warnings = await runWithWarnings(async (session) => {
    const snapshot = await resolveConfigWidePluginMetadataSnapshotAsync({
      config,
      env: process.env,
    });
    expect(snapshot.index.plugins.map((p) => p.pluginId)).toContain(pluginId);
    expect(
      await loadPluginCliDescriptors({ cfg: config, primaryCommand: "memory", session }),
    ).toEqual([expect.objectContaining({ name: "memory" })]);
    expect(
      await resolvePluginCliRootOwnerIds({ cfg: config, primaryCommand: "memory", session }),
    ).toEqual([pluginId]);
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
}

describe("CLI plugin source receipt state-engine selection", () => {
  it.each(["status", "index"] as const)(
    "forwards configured PostgreSQL state selection to source-receipt workers for memory %s",
    async (subcommand) => {
      const fixture = createReceiptPluginFixture();
      const dsn = "postgresql://127.0.0.1:5432/openclaw_ported_test";
      const config = fixture.makeConfig({
        families: { state: { engine: "postgres" } },
        postgres: { connection: pgEnvConn("OPENCLAW_TEST_PG_DSN"), schemaPrefix: "openclaw" },
      });
      const anchorPath = writePostgresStateAnchor(fixture.stateDir);
      fs.writeFileSync(fixture.configPath, JSON.stringify(config));
      const readConns: string[] = [];
      const publishConns: string[] = [];
      vi.spyOn(stateReadonly, "executeExistingOpenClawStateRead").mockImplementation(
        async (_opts, command) => {
          readConns.push(getDatabaseEngineSelection()?.postgres?.connection ?? "");
          return command.type === "plugins.deferredMigrations.read"
            ? { ok: true as const, sourceAdmitted: true, type: command.type, pending: [] }
            : { ok: true as const, sourceAdmitted: true, type: command.type, rows: [] };
        },
      );
      vi.spyOn(stateWorkerStore, "runOpenClawStateWorkerOperation").mockImplementation(
        async (context, operation) => {
          publishConns.push(context.databaseEngineSelection?.postgres?.connection ?? "");
          const execute = (async () => ({ published: true })) as unknown as DomainScope["execute"];
          return await operation({ execute });
        },
      );

      await withEnvAsync({ ...fixture.env, OPENCLAW_TEST_PG_DSN: dsn }, () =>
        runMemorySubcommandFlow(config, fixture.pluginId, subcommand),
      );
      expect(new Set(readConns)).toEqual(new Set([dsn]));
      expect(new Set(publishConns)).toEqual(new Set([dsn]));
      expectAnchorOnly(anchorPath);
    },
  );

  it.skipIf(!connection).each(["status", "index"] as const)(
    "persists CLI plugin source receipts to live PostgreSQL for memory %s",
    async (subcommand) => {
      const fixture = createReceiptPluginFixture();
      const schemaPrefix = `cli_rcpt_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const config = fixture.makeConfig({
        families: { state: { engine: "postgres" } },
        postgres: { connection: pgEnvConn("OPENCLAW_TEST_PG_DSN"), schemaPrefix },
      });
      const env = { ...fixture.env, OPENCLAW_TEST_PG_DSN: connection! };
      fs.writeFileSync(fixture.configPath, JSON.stringify(config));
      const pgSelection = {
        effectiveEngines: resolveDatabaseFamilyEngines(config),
        postgres: { connection: connection!, schemaPrefix },
      };
      const client = new pg.Client({ connectionString: connection });
      await client.connect();
      try {
        await withDatabaseEngineSelection(pgSelection, () =>
          refreshPersistedInstalledPluginIndex({ config, env }),
        );
        await closeOpenClawStateDatabaseAsync();
        resetPluginLoaderTestStateForTest();
        bundledDiscovery.clearBundledDiscoveryModeMemo();

        await withEnvAsync(env, () =>
          runMemorySubcommandFlow(config, fixture.pluginId, subcommand),
        );
        await expectPersistedReceipts(pgSelection, env, fixture.pluginId);
        expectAnchorOnly(resolveOpenClawStateSqlitePath(env));
      } finally {
        await closeOpenClawStateDatabaseAsync();
        await dropPostgresTestSchemas(client, schemaPrefix);
        await client.end();
      }
    },
  );

  it("keeps SQLite state direct when another database family configures an unresolved PostgreSQL DSN", async () => {
    const fixture = createReceiptPluginFixture();
    const config = fixture.makeConfig({
      families: { state: { engine: "sqlite" }, workboard: { engine: "postgres" } },
      postgres: { connection: pgEnvConn("OPENCLAW_UNSET_WORKBOARD_DSN") },
    });
    await seedSqliteIndexedConfig(fixture, config);
    const resolveSelection = vi.spyOn(dbEngineConfig, "resolveDatabaseEngineSelection");

    await withEnvAsync({ ...fixture.env, OPENCLAW_UNSET_WORKBOARD_DSN: undefined }, async () => {
      const warnings = await runWithWarnings(async (session) => {
        await registerLazyCli("memory", session, true);
        await ensureCliPluginRegistryLoaded({ scope: "memory", config });
      });
      expect(warnings).toEqual([]);
      expect(resolveSelection).not.toHaveBeenCalled();
    });

    await expectPersistedReceipts(sqliteOnlySelection, fixture.env, fixture.pluginId);
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
    await seedSqliteIndexedConfig(fixture, config);

    await withEnvAsync(fixture.env, async () => {
      const warnings = await runWithWarnings(async (session) => {
        const { program, registeredCfg } = await registerLazyCli("memory", session, false);
        await ensureCliPluginRegistryLoaded({ scope: "memory", config: registeredCfg });
        await program.parseAsync(["memory", "status"], { from: "user" });
      });
      expect(warnings).toEqual([]);
    });

    await expectPersistedReceipts(sqliteOnlySelection, fixture.env, fixture.pluginId);
  });
});
