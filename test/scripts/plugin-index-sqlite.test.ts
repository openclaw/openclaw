import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const MODULE_URL = pathToFileURL(path.resolve("scripts/e2e/lib/plugin-index-sqlite.mjs")).href;
let importCounter = 0;
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

async function loadPluginIndex(env: Record<string, string> = {}) {
  return withEnvAsync(env, () => import(`${MODULE_URL}?case=${importCounter++}`));
}

function sqlitePath(root: string) {
  return path.join(root, "state", "openclaw.sqlite");
}

function withSqlite<T>(root: string, action: (db: DatabaseSync) => T): T {
  const dbPath = sqlitePath(root);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    return action(db);
  } finally {
    db.close();
  }
}

function writeLegacyIndex(root: string, text: string) {
  const file = path.join(root, "plugins", "installs.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function currentValueJson(installRecords: unknown) {
  return JSON.stringify({ revision: Date.now(), index: { installRecords } });
}

function writeCurrentSqliteIndex(root: string, valueJson: string, schemaVersion = 13) {
  withSqlite(root, (db) => {
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
    db.prepare(
      `CREATE TABLE config_machine_state AS
       SELECT 'plugins.installedIndex' AS state_key, ? AS value_json`,
    ).run(valueJson);
  });
}

function writePreV13SqliteIndex(root: string, installRecordsJson: string, schemaVersion = 12) {
  withSqlite(root, (db) => {
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
    db.prepare(
      `CREATE TABLE installed_plugin_index AS SELECT
       'installed-plugin-index' AS index_key, 1 AS version, '1' AS host_contract_version,
       '1' AS compat_registry_version, 1 AS migration_version, 'hash' AS policy_hash,
       0 AS generated_at_ms, NULL AS refresh_reason, ? AS install_records_json,
       '[]' AS plugins_json, '[]' AS diagnostics_json, NULL AS warning`,
    ).run(installRecordsJson);
  });
}

function readTableNames(root: string) {
  const db = new DatabaseSync(sqlitePath(root), { readOnly: true });
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

describe("plugin index SQLite E2E helpers", () => {
  let root: string;
  let options: { stateDir: string; configPath: string };
  const readRecords = async () => (await loadPluginIndex()).readPluginInstallRecords(options);
  beforeEach(() => {
    root = tempRoots.make("openclaw-plugin-index-");
    options = { stateDir: root, configPath: path.join(root, "openclaw.json") };
  });
  it("reads legacy install records when SQLite index state is absent", async () => {
    writeLegacyIndex(
      root,
      JSON.stringify({ records: { demo: { installPath: "/tmp/demo", source: "npm" } } }),
    );

    expect(await readRecords()).toEqual({
      demo: { installPath: "/tmp/demo", source: "npm" },
    });
  });

  const sources = [
    ["legacy JSON", writeLegacyIndex, "JSON artifact"],
    ["current SQLite", writeCurrentSqliteIndex, "value_json"],
    ["pre-v13 SQLite", writePreV13SqliteIndex, "install_records_json"],
  ] as const;
  it.each(sources)("keeps malformed %s as an empty fallback", async (_name, write) => {
    write(root, "{not-json");
    expect(await readRecords()).toEqual({});
  });
  it.each(sources)("rejects oversized %s before parsing it", async (_name, write, column) => {
    write(root, JSON.stringify({ filler: "x".repeat(128) }));
    const index = await loadPluginIndex({ OPENCLAW_PLUGIN_INDEX_JSON_MAX_BYTES: "64" });
    expect(() => index.readPluginInstallIndex(options)).toThrow(
      `plugin index ${column} exceeded 64 bytes`,
    );
  });

  it.each([
    [13, "current"],
    [12, "legacy"],
    [0, "current"],
  ] as const)("selects the authoritative %s schema index", async (schema, selected) => {
    writePreV13SqliteIndex(root, JSON.stringify({ legacy: { source: "npm" } }), schema);
    writeCurrentSqliteIndex(root, currentValueJson({ current: { source: "npm" } }), schema);
    expect(await readRecords()).toEqual({ [selected]: { source: "npm" } });
  });

  it.each([
    [13, writePreV13SqliteIndex, JSON.stringify({ stale: { source: "npm" } })],
    [12, writeCurrentSqliteIndex, currentValueJson({ future: { source: "npm" } })],
  ] as const)("never cross-reads another schema's table for v%s", async (schema, write, value) => {
    write(root, value, schema);
    expect(await readRecords()).toEqual({});
  });

  it.each([12, 13])("bounds only required summary fields in schema v%s", async (schema) => {
    const index = await loadPluginIndex();
    const installRecords = { demo: { source: "npm", future: { values: [false, null, "keep"] } } };
    const plugins = [
      { pluginId: "disabled", enabled: false, rootDir: "/disabled" },
      { pluginId: "enabled", enabled: true, rootDir: "/enabled" },
      { pluginId: "missing" },
      { pluginId: "null", enabled: null, rootDir: null },
    ];
    index.writePluginInstallIndexForE2E(
      {
        installRecords,
        plugins: plugins.map((plugin) => ({ ...plugin, description: "x".repeat(300_000) })),
        diagnostics: ["y".repeat(1024 * 1024)],
      },
      { ...options, storageMode: schema === 12 ? "pre-v13" : "current" },
    );
    withSqlite(root, (db) => db.exec(`PRAGMA user_version = ${schema}`));

    expect(index.readPluginInstallIndex({ ...options, summary: true })).toEqual({
      installRecords,
      plugins,
    });
    expect(() => index.readPluginInstallIndex(options)).toThrow(/exceeded 1048576 bytes/u);
  });

  it.each(["receipts", "roots"])("retains the summary byte cap for required %s", async (field) => {
    const index = await loadPluginIndex();
    index.writePluginInstallIndexForE2E(
      {
        installRecords: { demo: { future: field === "receipts" ? "é".repeat(600_000) : "kept" } },
        plugins: [
          { pluginId: "demo", rootDir: field === "roots" ? "x".repeat(1024 * 1024) : "/demo" },
        ],
      },
      options,
    );
    expect(() => index.readPluginInstallIndex({ ...options, summary: true })).toThrow(
      "plugin index summary exceeded 1048576 bytes",
    );
  });

  it.each([
    { mode: "current", schemaVersion: 0, options: {}, current: true },
    { mode: "pre-v13", schemaVersion: 0, options: { storageMode: "pre-v13" }, current: false },
    ...[0, 13].map((schemaVersion) => ({
      mode: `existing schema v${schemaVersion}`,
      schemaVersion,
      options: { storageMode: "existing-schema" },
      current: schemaVersion >= 13,
    })),
  ])(
    "writes only the $mode storage contract",
    async ({ current, options: writerOptions, schemaVersion }) => {
      withSqlite(root, (db) => db.exec(`PRAGMA user_version = ${schemaVersion}`));
      const index = await loadPluginIndex();
      index.writePluginInstallIndexForE2E(
        { installRecords: { demo: { source: "npm" } } },
        { stateDir: root, ...writerOptions },
      );

      const tables = readTableNames(root);
      expect(tables).toContain(current ? "config_machine_state" : "installed_plugin_index");
      expect(tables).not.toContain(current ? "installed_plugin_index" : "config_machine_state");
      expect(index.readPluginInstallRecords({ stateDir: root })).toEqual({
        demo: { source: "npm" },
      });
    },
  );

  it("rejects unknown writer storage modes", async () => {
    const index = await loadPluginIndex();
    expect(() =>
      index.writePluginInstallIndexForE2E(
        { installRecords: {} },
        { stateDir: root, storageMode: "future" },
      ),
    ).toThrow("Unknown plugin index storage mode: future");
  });
});
