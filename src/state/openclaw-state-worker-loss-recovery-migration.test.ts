import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { hasPostgresCatalogColumn } from "../infra/database-engine/postgres-catalog.js";
import { loadStatePortDescriptor } from "../infra/database-engine/state-port-descriptor.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import {
  migrateBoundedStateSchema,
  runStateSchemaMigrationTransaction,
  writeCurrentStateSchemaMetadata,
} from "./openclaw-state-db-maintenance.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { getOpenClawStatePredecessorSchema } from "./openclaw-state-schema-runtime.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";
import { SCHEMA_MIGRATION_BACKUP_TABLES } from "./schema-migration-backup-tables.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

const directories = useStateDatabaseTempDirs();
const table = "worker_session_placements";
const column = "confirmed_loss_recovery_json";

function legacy() {
  const options = { env: { OPENCLAW_STATE_DIR: directories.make("worker-loss-v40-") } };
  const pathname = resolveOpenClawStateSqlitePath(options.env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(getOpenClawStatePredecessorSchema(40));
  db.exec(`PRAGMA user_version = 40;
    INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
      VALUES ('primary', 'global', 40, 1, 1);
    INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
      VALUES ('state.schema.contentVersion', '40', 1);
    INSERT INTO session_repository_workspaces
      (workspace_id, agent_id, session_key, url, requested_ref, base_commit, branch, revision, created_at_ms, updated_at_ms)
      VALUES ('11111111-1111-4111-8111-111111111111', 'main', 'agent:main:kept', 'https://example.invalid/repository.git', 'main', '${"a".repeat(40)}', 'saved/kept', 7, 1, 1);
    INSERT INTO worker_session_placements
      (session_id, agent_id, session_key, state, transition_generation, created_at_ms, updated_at_ms, state_changed_at_ms)
      VALUES ('kept', 'main', 'agent:main:kept', 'local', 9, 1, 2, 2);
    INSERT INTO state_leases (scope, lease_key, owner, created_at, updated_at)
      VALUES ('fixture', 'fixture-lease', 'fixture-owner', 1, 1);
    ANALYZE state_leases;`);
  return {
    options,
    pathname,
    placement: db.prepare(`SELECT * FROM ${table}`).get(),
    repository: db.prepare("SELECT * FROM session_repository_workspaces").get(),
  };
}

function expectRows(db: DatabaseSync, fixture: ReturnType<typeof legacy>, version: 40 | 41) {
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
  expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
    schema_version: version,
  });
  expect(readStateSchemaContentVersion(db)).toBe(version);
  expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([
    version === 40 ? fixture.placement : { ...fixture.placement, [column]: null },
  ]);
  expect(db.prepare("SELECT * FROM session_repository_workspaces").get()).toEqual(
    fixture.repository,
  );
}

it("upgrades published v40 through the runtime owner without rewriting repository or placement rows", async () => {
  const fixture = legacy();
  const { options, pathname } = fixture;
  try {
    await withStateMigrationBackupForTest(options, async () => {
      using scope = new DatabaseSync(pathname);
      await assertSqliteMigrationScopePreserved(
        scope,
        [...SCHEMA_MIGRATION_BACKUP_TABLES.state[41]!, "schema_meta", "config_machine_state"],
        () => openOpenClawStateDatabase(options),
      );
    });
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
  using db = new DatabaseSync(pathname, { readOnly: true });
  expectRows(db, fixture, 41);
});

it("rolls back the v41 column and all version markers on commit refusal", async () => {
  const fixture = legacy();
  const { options, pathname } = fixture;
  await withStateMigrationBackupForTest(options, () => {
    using db = new DatabaseSync(pathname);
    const refused = new Error("v41 fixture commit refused");
    const withCommit = () => {
      throw refused;
    };
    const migrate = () => {
      const steps = migrateBoundedStateSchema(db, 40, {
        env: options.env,
        versionMigrationOnly: true,
      });
      expect(steps).toHaveLength(1);
      writeCurrentStateSchemaMetadata(db, 2);
      expectRows(db, fixture, 41);
    };
    expect(() => runStateSchemaMigrationTransaction(db, pathname, migrate, { withCommit })).toThrow(
      refused,
    );
    expectRows(db, fixture, 40);
    const marker = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?");
    expect(marker.get("state.schema.contentVersion")).toEqual({ value_json: "40" });
  });
});

it("keeps v40 PostgreSQL copy and validation facts free of the v41 placement column", async () => {
  for (const version of [40, 41]) {
    const descriptor = await loadStatePortDescriptor(version);
    expect(
      descriptor.tables
        .find((entry) => entry.name === table)
        ?.columns.some((entry) => entry.name === column),
    ).toBe(version === 41);
    expect(descriptor.preData.includes(`"${column}" text COLLATE "C"`)).toBe(version === 41);
    expect(hasPostgresCatalogColumn(descriptor.expectedCatalog, table, column)).toBe(
      version === 41,
    );
  }
});
