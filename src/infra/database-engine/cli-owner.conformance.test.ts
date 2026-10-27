import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Command } from "commander";
import { Client, type QueryResultRow } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ensureCliExecutionBootstrap } from "../../cli/command-execution-startup.js";
import { resolveCliStartupPolicy } from "../../cli/command-startup-policy.js";
import { createConfigIO } from "../../config/io.factory.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { configWritePostCommitRollback } from "../../config/io.types.js";
import { resetConfigRuntimeState } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.js";
import { runWithLocalStateOwner } from "../../plugin-sdk/cli-state-owner.js";
import { registerPluginCliCommandsFromValidatedConfig } from "../../plugins/cli.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { dropPostgresTestSchemas } from "../postgres-sync/schema-cleanup.test-support.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { resolveDatabaseEngineSelection } from "./config.js";
import { getDatabaseEngineSelection, withDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const directories = useAutoCleanupTempDirTracker(afterEach);

function readAnchor(pathname: string) {
  using anchor = openNodeSqliteDatabase(pathname, { readOnly: true });
  return {
    identity: anchor.prepare("SELECT store_id, engine, schema FROM openclaw_engine_anchor").all(),
    tables: anchor
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all(),
  };
}

function withDsn(database: OpenClawConfig["database"], id: string): OpenClawConfig["database"] {
  return {
    ...database,
    postgres: {
      ...database?.postgres,
      connection: { source: "env", provider: "default", id },
    },
  };
}

async function configWriteFixture(dsn = "OPENCLAW_CONFIG_WRITE_TEST_DSN") {
  const root = directories.make("config-write-postgres-");
  const foreignRoot = directories.make("config-write-foreign-");
  const configPath = path.join(root, "openclaw.json");
  const databasePath = path.join(root, "state", "openclaw.sqlite");
  const schemaPrefix = `config_write_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const config: OpenClawConfig = {
    gateway: { mode: "local" },
    plugins: { enabled: false },
    database: withDsn({ engine: "postgres", postgres: { schemaPrefix } }, dsn),
  };
  const paths = {
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  const env: NodeJS.ProcessEnv = { ...process.env, ...paths, [dsn]: connection };
  for (const [key, value] of Object.entries(paths)) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv(dsn, undefined);
  vi.stubEnv("OPENCLAW_CONFIG_WRITE_UNRESOLVED_DSN", undefined);
  resetDatabaseEngineSelectionForTest();
  resetConfigRuntimeState();
  await fs.writeFile(configPath, JSON.stringify(config));
  const client = new Client({ connectionString: connection });
  await client.connect();
  const rows = async <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) =>
    (await client.query<T>(sql, values)).rows;
  const close = async () => {
    try {
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      await closeOpenClawStateDatabaseByPathAsync(
        path.join(foreignRoot, "state", "openclaw.sqlite"),
      );
      await dropPostgresTestSchemas(client, schemaPrefix);
    } finally {
      await client.end();
      resetDatabaseEngineSelectionForTest();
      resetConfigRuntimeState();
      vi.unstubAllEnvs();
    }
  };
  const warn = vi.fn();
  const io = createConfigIO({ env, configPath, observe: false, logger: { warn, error: vi.fn() } });
  const own = <T>(run: (assertCurrent: () => void) => Promise<T>) =>
    runWithLocalStateOwner({
      method: "config set",
      params: {},
      target: configPath,
      onForeignOwner: "refuse",
      runLocal: ({ assertCurrent }) => run(assertCurrent),
    });
  const openState = async () =>
    withDatabaseEngineSelection(await resolveDatabaseEngineSelection(config, env), async () => {
      const namespace = withEngineStoreAdmission(
        () => getPostgresPhysicalFacts(openOpenClawStateDatabase({ env }).db)?.namespace,
      );
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      return namespace;
    });
  return {
    root,
    foreignRoot,
    configPath,
    databasePath,
    config,
    env,
    rows,
    io,
    warn,
    own,
    openState,
    [Symbol.asyncDispose]: close,
  };
}

it.skipIf(!connection).each([false, true])(
  "keeps config metadata, journal, and compensation on PostgreSQL (existing=%s)",
  async (existing) => {
    await using f = await configWriteFixture();
    if (existing) {
      await f.openState();
    }
    await f.own(async (assertCurrent) => {
      // The writer's selected root must not be replaced by a caller's ambient environment.
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: f.foreignRoot,
          OPENCLAW_CONFIG_PATH: path.join(f.foreignRoot, "openclaw.json"),
        },
        async () => {
          const first = await f.io.writeConfigFile({
            ...f.config,
            memory: { search: { provider: "none" } },
          });
          expect(getDatabaseEngineSelection()).toBeUndefined();
          const anchor = readAnchor(f.databasePath);
          expect(anchor.tables).toEqual([{ name: "openclaw_engine_anchor" }]);
          const namespace = anchor.identity[0]?.schema;
          assert(typeof namespace === "string");
          const metadata = await f.rows<{ value_json: string }>(
            `SELECT value_json FROM "${namespace}".config_machine_state WHERE state_key = 'config.lastTouchedAt'`,
          );
          expect(metadata).toHaveLength(1);
          expect(JSON.parse(metadata[0]!.value_json)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
          const journal = async () =>
            (
              await f.rows<{ payload_json: string }>(
                `SELECT payload_json FROM "${namespace}".diagnostic_events WHERE scope = 'config-snapshot' AND event_key = 'latest'`,
              )
            ).map((row) => JSON.parse(row.payload_json));
          expect(await journal()).toMatchObject([{ rawHash: first.persistedHash }]);
          expect(
            await f.rows(
              `SELECT 1 FROM "${namespace}".diagnostic_events WHERE scope = 'config-audit'`,
            ),
          ).toHaveLength(1);

          const second = await withDatabaseEngineSelection(
            await resolveDatabaseEngineSelection(f.config, f.env),
            () =>
              f.io.writeConfigFile({
                ...first.persistedConfig,
                gateway: { mode: "local", port: 19472 },
                database: withDsn(f.config.database, "OPENCLAW_CONFIG_WRITE_UNRESOLVED_DSN"),
              }),
          );
          expect(await journal()).toMatchObject([{ rawHash: second.persistedHash }]);
          const compensation = second[configWritePostCommitRollback];
          assert(compensation);
          const revoked = new Error("config writer revoked");
          await expect(
            compensation.restoreEffects(() => {
              throw revoked;
            }),
          ).rejects.toBe(revoked);
          expect(await journal()).toMatchObject([{ rawHash: second.persistedHash }]);
          expect(await compensation.restoreFile(assertCurrent)).toBe(true);
          await compensation.restoreEffects(assertCurrent);
          expect(await journal()).toMatchObject([{ rawHash: first.persistedHash }]);
          expect(readAnchor(f.databasePath)).toEqual(anchor);
          await expect(
            fs.stat(path.join(f.foreignRoot, "state", "openclaw.sqlite")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect(f.warn).not.toHaveBeenCalled();
        },
      );
    });
  },
);

it.skipIf(!connection)(
  "accepts unresolved PostgreSQL config edits without creating native state",
  async () => {
    await using f = await configWriteFixture();
    delete f.env.OPENCLAW_CONFIG_WRITE_TEST_DSN;
    await f.own(async () => {
      const written = await f.io.writeConfigFile({
        ...f.config,
        memory: { search: { provider: "none" } },
      });
      expect(JSON.parse(await fs.readFile(f.configPath, "utf8"))).toMatchObject({
        memory: { search: { provider: "none" } },
      });
      expect(written.persistedConfig.database?.engine).toBe("postgres");
      expect(f.warn).toHaveBeenCalledWith(
        expect.stringContaining("Config metadata state update failed:"),
      );
      await expect(fs.stat(f.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      const refused = new Error("config publication refused");
      await expect(
        f.io.writeConfigFile(
          { ...written.persistedConfig, gateway: { mode: "local", port: 19472 } },
          {
            beforeCommit: () => {
              throw refused;
            },
          },
        ),
      ).rejects.toBe(refused);
      await expect(fs.stat(f.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      f.env.OPENCLAW_CONFIG_WRITE_REPAIRED_DSN = connection;
      await f.io.writeConfigFile({
        ...written.persistedConfig,
        database: withDsn(f.config.database, "OPENCLAW_CONFIG_WRITE_REPAIRED_DSN"),
      });
      expect(readAnchor(f.databasePath).tables).toEqual([{ name: "openclaw_engine_anchor" }]);
    });
  },
);

it.skipIf(!connection)(
  "discovers plugin commands without observing config health or creating state",
  async () => {
    await using f = await configWriteFixture();
    using warning = vi.spyOn(console, "warn");
    await registerPluginCliCommandsFromValidatedConfig(new Command(), f.env, undefined, {
      mode: "metadata",
    });
    expect(warning).not.toHaveBeenCalled();
    await expect(fs.stat(f.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.skipIf(!connection).each([
  { command: "index", flags: [] },
  { command: "status", flags: ["--index"] },
  { command: "status", flags: ["--fix"] },
])(
  "validates memory $command $flags before PostgreSQL ownership without health writes",
  async ({ command, flags }) => {
    await using f = await configWriteFixture();
    const namespace = await f.openState();
    assert(namespace);
    const before = readAnchor(f.databasePath);
    const healthRows = () =>
      f.rows<{ config_path: string }>(
        `SELECT config_path FROM "${namespace}".config_health_entries`,
      );
    expect(await healthRows()).toEqual([]);
    const commandPath = ["memory", command];
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("fixture config rejected");
      },
    };
    const validate = () =>
      ensureCliExecutionBootstrap({
        runtime,
        commandPath,
        startupPolicy: resolveCliStartupPolicy({
          argv: ["node", "openclaw", ...commandPath, ...flags],
          commandPath,
          jsonOutputMode: false,
        }),
        loadPlugins: false,
      });
    using warning = vi.spyOn(console, "warn");
    await validate();
    expect(runtime.error).not.toHaveBeenCalled();
    await fs.writeFile(f.configPath, JSON.stringify({ gateway: { mode: "invalid-mode" } }));
    await expect(validate()).rejects.toThrow("fixture config rejected");
    expect(warning).not.toHaveBeenCalledWith(
      expect.stringContaining("Config health-state write failed:"),
    );
    expect(await healthRows()).toEqual([]);
    expect(readAnchor(f.databasePath)).toEqual(before);
    expect(getDatabaseEngineSelection()).toBeUndefined();
  },
);

it.skipIf(!connection)(
  "admits PostgreSQL from selected state dotenv before a cold local command observes config",
  async () => {
    await using f = await configWriteFixture("OPENCLAW_CLI_OWNER_TEST_DSN");
    const { root, configPath, databasePath, config, rows } = f;
    const raw = `${JSON.stringify(config)}\n`;
    await fs.writeFile(configPath, raw);
    await fs.writeFile(
      path.join(root, ".env"),
      `OPENCLAW_CLI_OWNER_TEST_DSN=${JSON.stringify(connection)}\n`,
      { mode: 0o600 },
    );
    // Seed a prior Gateway's store without installing a process-wide CLI boot choice.
    const namespace = await f.openState();
    assert(namespace);
    expect(getDatabaseEngineSelection()).toBeUndefined();
    expect(process.env.OPENCLAW_CLI_OWNER_TEST_DSN).toBeUndefined();
    const anchorBefore = readAnchor(databasePath);
    expect(anchorBefore.tables).not.toContainEqual({ name: "config_health_entries" });

    const operation = {
      method: "memory.cli",
      params: {},
      target: "memory stores",
      onForeignOwner: "refuse" as const,
      databaseEngine: "configured" as const,
      runLocal: async () => await captureRuntimeConfigAsyncReader({ skipPluginValidation: true })(),
    };
    const loaded = await runWithLocalStateOwner(operation);
    expect(loaded.database?.engine).toBe("postgres");
    expect(getDatabaseEngineSelection()).toBeUndefined();
    await closeOpenClawStateDatabaseByPathAsync(databasePath);

    const health = await rows<{ last_known_good_json: string }>(
      `SELECT last_known_good_json FROM "${namespace}".config_health_entries WHERE config_path = $1`,
      [configPath],
    );
    expect(health).toHaveLength(1);
    assert(health[0]);
    expect(JSON.parse(health[0].last_known_good_json)).toMatchObject({
      hash: createHash("sha256").update(raw).digest("hex"),
      bytes: Buffer.byteLength(raw),
      gatewayMode: "local",
    });
    expect(readAnchor(databasePath)).toEqual(anchorBefore);
  },
);
