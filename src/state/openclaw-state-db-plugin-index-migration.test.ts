// Preserve legacy plugin installation state across the v13 fold.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { readConfigMachineState } from "./config-machine-state.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL } from "./openclaw-state-schema-v13-widerow.test-support.js";

const templateDirs = useAutoCleanupTempDirTracker(afterAll);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});
let templatePath: string;

beforeAll(() => {
  const stateDir = templateDirs.make("openclaw-plugin-index-template-");
  templatePath = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } }).path;
  closeOpenClawStateDatabaseForTest();
  const legacy = new (requireNodeSqlite().DatabaseSync)(templatePath);
  try {
    legacy.exec(STATE_SCHEMA_13_TO_12_DOWNGRADE_SQL);
  } finally {
    legacy.close();
  }
});

function createLegacyStateDatabase() {
  const stateDir = tempDirs.make("openclaw-plugin-index-migration-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const databasePath = resolveOpenClawStateSqlitePath(options.env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.copyFileSync(templatePath, databasePath);
  return { legacy: new (requireNodeSqlite().DatabaseSync)(databasePath), options };
}

describe("v13 plugin-index migration", () => {
  it.each(
    (["runtime open", "doctor repair"] as const).flatMap((migrationPath) => [
      [migrationPath, "install_records_json", "[]"],
      [migrationPath, "install_records_json", "{"],
      [migrationPath, "plugins_json", "{}"],
      [migrationPath, "diagnostics_json", "{"],
    ]) as Array<
      readonly [
        "runtime open" | "doctor repair",
        "install_records_json" | "plugins_json" | "diagnostics_json",
        string,
      ]
    >,
  )(
    "preserves an invalid plugin-index row during v13 %s when %s is invalid (%s)",
    (migrationPath, column, value) => {
      const { legacy, options } = createLegacyStateDatabase();
      const values = {
        install_records_json: '{ "demo": { "source": "npm", "spec": "demo@1.0.0" } }',
        plugins_json: "[]",
        diagnostics_json: "[]",
        [column]: value,
      };
      legacy
        .prepare(
          `INSERT INTO installed_plugin_index (
           index_key, version, host_contract_version, compat_registry_version,
           migration_version, policy_hash, generated_at_ms, install_records_json,
           plugins_json, diagnostics_json, updated_at_ms
         ) VALUES ('installed-plugin-index', 1, 'host', 'compat', 1, 'policy', 10, ?, ?, ?, 11)`,
        )
        .run(values.install_records_json, values.plugins_json, values.diagnostics_json);
      const original = legacy.prepare("SELECT * FROM installed_plugin_index").get();
      legacy.close();

      if (migrationPath === "doctor repair") {
        repairOpenClawStateDatabaseSchema(options);
      }
      const migrated = openOpenClawStateDatabase(options);
      expect(
        migrated.db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'installed_plugin_index'")
          .get(),
      ).toBeUndefined();
      const preserved = migrated.db
        .prepare("SELECT payload_json FROM diagnostic_events WHERE scope = ?")
        .get("plugins.installedIndex.quarantine");
      expect(preserved).toBeDefined();
      expect(JSON.parse(String(preserved?.payload_json))).toMatchObject({
        level: "warn",
        message: expect.stringContaining("openclaw doctor --fix"),
        raw: original,
      });
      const folded = readConfigMachineState<{ index: { installRecords: unknown } }>(
        "plugins.installedIndex",
        options,
      );
      expect(folded?.index.installRecords).toEqual(
        column === "install_records_json" ? null : JSON.parse(values.install_records_json),
      );
      expect(migrated.db.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      closeOpenClawStateDatabaseForTest();
      expect(readSqliteNumberPragma(openOpenClawStateDatabase(options).db, "user_version")).toBe(
        OPENCLAW_STATE_SCHEMA_VERSION,
      );
      expect(
        openOpenClawStateDatabase(options)
          .db.prepare("SELECT payload_json FROM diagnostic_events WHERE scope = ?")
          .all("plugins.installedIndex.quarantine"),
      ).toEqual([preserved]);
    },
  );

  it("keeps the legacy plugin-index row when quarantine preservation fails", () => {
    const { legacy, options } = createLegacyStateDatabase();
    legacy.exec(`
      INSERT INTO installed_plugin_index (
        index_key, version, host_contract_version, compat_registry_version,
        migration_version, policy_hash, generated_at_ms, install_records_json,
        plugins_json, diagnostics_json, updated_at_ms
      ) VALUES ('installed-plugin-index', 1, 'host', 'compat', 1, 'policy', 10, '{', '[]', '[]', 11);
      INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at, sequence)
      VALUES ('plugins.installedIndex.quarantine', 'retained', '{}', 1, 9007199254740991);
    `);
    const original = legacy.prepare("SELECT * FROM installed_plugin_index").get();
    legacy.close();

    expect(() => openOpenClawStateDatabase(options)).toThrow("Audit sequence exhausted");
    const retained = new (requireNodeSqlite().DatabaseSync)(
      resolveOpenClawStateSqlitePath(options.env),
    );
    try {
      expect(retained.prepare("SELECT * FROM installed_plugin_index").get()).toEqual(original);
      expect(readSqliteNumberPragma(retained, "user_version")).toBe(12);
      expect(
        retained
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get("plugins.installedIndex"),
      ).toBeUndefined();
    } finally {
      retained.close();
    }
  });
});
