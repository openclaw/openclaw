import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { inspectStateDatabaseSchema } from "./openclaw-state-schema-preflight.js";
import { getOpenClawStatePredecessorSchema } from "./openclaw-state-schema-runtime.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";
import {
  resolveSchemaMigrationBackupTables,
  resolveSchemaMigrationIntegrityCheck,
} from "./schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});

it("upgrades v39 within the pairing table backup scope without assigning legacy operators", async () => {
  const env = { OPENCLAW_STATE_DIR: directories.make("personal-operator-v39-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  const scope = ["config_machine_state", "device_pairing_paired", "schema_meta"];
  const crossing = { kind: "state", foundVersion: 39, supportedVersion: 40 } as const;
  using source = new DatabaseSync(pathname);
  source.exec(getOpenClawStatePredecessorSchema(39));
  source.exec(
    "PRAGMA user_version = 39; INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at) VALUES ('primary', 'global', 39, 1, 1);" +
      "INSERT INTO device_pairing_paired (device_id, public_key, created_at_ms, approved_at_ms) VALUES ('legacy', 'legacy-key', 1, 1);",
  );
  expect(
    source
      .prepare(
        "SELECT name FROM pragma_table_info('device_pairing_paired') WHERE name = 'operator_profile_id'",
      )
      .get(),
  ).toBeUndefined();
  await withStateMigrationBackupForTest({ env }, async () => {
    const { db } = await assertSqliteMigrationScopePreserved(source, scope, () =>
      openOpenClawStateDatabase({ env }),
    );
    expect(
      db
        .prepare("SELECT operator_profile_id FROM device_pairing_paired WHERE device_id = 'legacy'")
        .get(),
    ).toEqual({ operator_profile_id: null });
    // PostgreSQL catalog admission also preserves physical column positions.
    using fresh = new DatabaseSync(":memory:");
    fresh.exec(OPENCLAW_STATE_SCHEMA_SQL);
    const columns = "SELECT name FROM pragma_table_info('device_pairing_paired') ORDER BY cid";
    expect(db.prepare(columns).all()).toEqual(fresh.prepare(columns).all());
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 40 });
    expect(
      db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual({ schema_version: 40 });
    expect(
      inspectStateDatabaseSchema(source, {
        pathname,
        supportedVersion: 39,
        purpose: "maintenance",
        scope: "state",
      }).schemas.incompatible,
    ).toMatchObject([{ kind: "state", foundVersion: 40, supportedVersion: 39 }]);
    expect(resolveSchemaMigrationBackupTables(crossing)).toEqual(scope);
    expect(resolveSchemaMigrationIntegrityCheck(crossing)).toEqual({
      check: "quick",
      tables: scope,
    });
  });
});
