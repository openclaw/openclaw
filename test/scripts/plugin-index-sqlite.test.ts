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

function openSqlite(root: string) {
  const dbPath = sqlitePath(root);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  return new DatabaseSync(dbPath);
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
  const db = openSqlite(root);
  try {
    db.exec(`
      PRAGMA user_version = ${schemaVersion};
      CREATE TABLE IF NOT EXISTS config_machine_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json
      `,
    ).run("plugins.installedIndex", valueJson, Date.now());
  } finally {
    db.close();
  }
}

function writePreV13SqliteIndex(root: string, installRecordsJson: string, schemaVersion = 12) {
  const db = openSqlite(root);
  try {
    db.exec(`
      PRAGMA user_version = ${schemaVersion};
      CREATE TABLE IF NOT EXISTS installed_plugin_index (
        index_key TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL,
        host_contract_version TEXT NOT NULL, compat_registry_version TEXT NOT NULL,
        migration_version INTEGER NOT NULL, policy_hash TEXT NOT NULL,
        generated_at_ms INTEGER NOT NULL, refresh_reason TEXT,
        install_records_json TEXT NOT NULL, plugins_json TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL, warning TEXT, updated_at_ms INTEGER NOT NULL
      );
    `);
    db.prepare(
      `
        INSERT INTO installed_plugin_index (
          index_key, version, host_contract_version, compat_registry_version,
          migration_version, policy_hash, generated_at_ms, refresh_reason,
          install_records_json, plugins_json, diagnostics_json, warning, updated_at_ms
        ) VALUES ('installed-plugin-index', 1, '1', '1', 1, 'hash', ?, NULL,
          ?, '[]', '[]', NULL, ?)
        ON CONFLICT(index_key) DO UPDATE SET
          install_records_json = excluded.install_records_json
      `,
    ).run(Date.now(), installRecordsJson, Date.now());
  } finally {
    db.close();
  }
}

function readTableNames(root: string) {
  const db = new DatabaseSync(sqlitePath(root), { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
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

  it("keeps malformed legacy install JSON as an empty fallback", async () => {
    writeLegacyIndex(root, "{not-json");
    expect(await readRecords()).toEqual({});
  });

  it("rejects oversized legacy install JSON before parsing it", async () => {
    writeLegacyIndex(root, JSON.stringify({ records: {}, filler: "x".repeat(128) }));

    const { readPluginInstallRecords } = await loadPluginIndex({
      OPENCLAW_PLUGIN_INDEX_JSON_MAX_BYTES: "64",
    });

    expect(() => readPluginInstallRecords(options)).toThrow(
      "plugin index JSON artifact exceeded 64 bytes",
    );
  });

  it("reads the current index for schema v13", async () => {
    writeCurrentSqliteIndex(root, currentValueJson({ current: { source: "npm" } }));

    expect(await readRecords()).toEqual({
      current: { source: "npm" },
    });
  });

  it("reads the retired index for pre-v13 schemas", async () => {
    writePreV13SqliteIndex(root, JSON.stringify({ legacy: { source: "npm" } }));
    const index = await loadPluginIndex();
    expect(index.readPluginInstallIndex(options)).toMatchObject({
      installRecords: { legacy: { source: "npm" } },
    });
  });

  it("prefers current state for unversioned databases", async () => {
    writePreV13SqliteIndex(root, JSON.stringify({ stale: { source: "npm" } }), 0);
    writeCurrentSqliteIndex(root, currentValueJson({ current: { source: "npm" } }), 0);

    expect(await readRecords()).toEqual({
      current: { source: "npm" },
    });
  });

  it("does not fall back to a retired row for schema v13", async () => {
    writePreV13SqliteIndex(root, JSON.stringify({ stale: { source: "npm" } }), 13);

    expect(await readRecords()).toEqual({});
  });

  it("does not read current state for pre-v13 schemas", async () => {
    writeCurrentSqliteIndex(root, currentValueJson({ future: { source: "npm" } }), 12);

    expect(await readRecords()).toEqual({});
  });

  it.each([
    {
      name: "current",
      write: () => writeCurrentSqliteIndex(root, "{not-json"),
    },
    {
      name: "pre-v13",
      write: () => writePreV13SqliteIndex(root, "{not-json"),
    },
  ])("keeps malformed $name SQLite state as an empty fallback", async ({ write }) => {
    write();

    expect(await readRecords()).toEqual({});
  });

  it.each([
    {
      name: "current",
      expected: "plugin index value_json exceeded 64 bytes",
      write: () => writeCurrentSqliteIndex(root, currentValueJson({ filler: "x".repeat(128) })),
    },
    {
      name: "pre-v13",
      expected: "plugin index install_records_json exceeded 64 bytes",
      write: () => writePreV13SqliteIndex(root, JSON.stringify({ filler: "x".repeat(128) })),
    },
  ])("rejects oversized $name SQLite state before parsing it", async ({ expected, write }) => {
    write();

    const { readPluginInstallIndex } = await loadPluginIndex({
      OPENCLAW_PLUGIN_INDEX_JSON_MAX_BYTES: "64",
    });

    expect(() => readPluginInstallIndex(options)).toThrow(expected);
  });

  it.each([
    { mode: "current", schemaVersion: 0, options: {}, current: true },
    { mode: "pre-v13", schemaVersion: 0, options: { storageMode: "pre-v13" }, current: false },
    ...[0, 12, 13].map((schemaVersion) => ({
      mode: `existing schema v${schemaVersion}`,
      schemaVersion,
      options: { storageMode: "existing-schema" },
      current: schemaVersion >= 13,
    })),
  ])(
    "writes only the $mode storage contract",
    async ({ current, options: writerOptions, schemaVersion }) => {
      const db = openSqlite(root);
      db.exec(`PRAGMA user_version = ${schemaVersion}`);
      db.close();
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
