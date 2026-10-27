import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  expectRow,
  expectRows,
  readRow,
  readRows,
} from "./openclaw-state-db-fixtures.test-support.js";
import { ensureNodeWorkerPreparedWorkspaceSchema as ensureWorkspace } from "./openclaw-state-db-schema-additive.js";
import {
  closeOpenClawStateDatabaseForTest as closeState,
  detectOpenClawStateDatabaseSchemaMigrations as detectMigrations,
  openOpenClawStateDatabase as openState,
  repairOpenClawStateDatabaseSchema as repairState,
  runOpenClawStateWriteTransaction as writeState,
} from "./openclaw-state-db.js";
import { removePreparedWorkerOwnershipColumns } from "./openclaw-state-schema-v17.test-support.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest as withBackup,
} from "./openclaw-state-schema.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const preparationKey = "a".repeat(64);
const retainedTables = [
  "worker_environment_credentials",
  "worker_environment_ssh_fallback_ports",
  "worker_inference_turns",
  "worker_session_placements",
  "worker_transcript_commit_heads",
  "plugin_state_entries",
] as const;

afterEach(() => closeState());

function readObligations(db: EngineConnection) {
  return Object.fromEntries(
    retainedTables.map((table) => [table, readRows(db, `SELECT * FROM ${table}`)]),
  );
}

function readSnapshot(db: EngineConnection) {
  return {
    version: readRow(db, "PRAGMA user_version"),
    metadata: readRows(db, "SELECT * FROM schema_meta"),
    machineState: readRows(db, "SELECT * FROM config_machine_state ORDER BY state_key"),
    schema: readRows(db, "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name"),
    environments: readRows(db, "SELECT rowid, * FROM worker_environments"),
    obligations: readObligations(db),
  };
}

function createLegacyWorkers(version = 16, publicationDeferred = false) {
  const options = {
    env: { OPENCLAW_STATE_DIR: tempDirs.make(`openclaw-prepared-v${version}-`) },
  };
  const databasePath = openState(options).path;
  if (publicationDeferred) {
    createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
  }
  closeState();
  using legacy = openNodeSqliteDatabase(databasePath);
  addPreCutoverClientCredentialTablesForTest(legacy);
  removePreparedWorkerOwnershipColumns(legacy);
  legacy.exec(`
      INSERT INTO plugin_state_entries VALUES
        ('fixture', 'namespace', 'retained', '{"keep":true}', 10, NULL),
        ('fixture', 'namespace', 'expiring', '{"keep":true}', 10, 1000);
      ALTER TABLE worker_environments ADD COLUMN future_note TEXT;
      PRAGMA user_version = ${version};
      UPDATE schema_meta SET schema_version = ${version} WHERE meta_key = 'primary';
      INSERT INTO worker_environments (
        environment_id, provider_id, profile_id, profile_snapshot_json,
        provision_operation_id, lease_id, state, owner_epoch,
        created_at_ms, updated_at_ms, state_changed_at_ms,
        destroy_requested_at_ms, last_error, future_note
      ) VALUES ('environment', 'fixture', 'profile', '{"cleanup":"retained"}',
        'fixed-operation', 'unresolved-lease', 'destroying', 2,
        10, 20, 20, 20, 'provider cleanup remains uncertain', 'preserve future data');
      INSERT INTO worker_environment_credentials (
        environment_id, credential_hash, bundle_hash, session_id,
        rpc_set_version, owner_epoch, expires_at_ms
      ) VALUES ('environment', 'fixture-hash', 'fixture-bundle', 'session', 1, 2, 1000);
      INSERT INTO worker_environment_ssh_fallback_ports VALUES ('environment', 0, 2222);
      INSERT INTO worker_session_placements (
        session_id, agent_id, session_key, execution_mode, state, environment_id,
        created_at_ms, updated_at_ms, state_changed_at_ms
      ) VALUES ('session', 'main', 'agent:main:fixture', 'remote-exec', 'provisioning',
        'environment', 10, 20, 20);
      INSERT INTO worker_inference_turns (
        session_id, run_epoch, run_id, turn_id, environment_id, request_hash,
        state, created_at_ms, updated_at_ms
      ) VALUES ('session', 2, 'run', 'turn', 'environment', 'request', 'pending', 10, 20);
      INSERT INTO worker_transcript_commit_heads VALUES ('session', 2, 'environment', 1, 20);
    `);
  if (publicationDeferred) {
    legacy.exec(`
        PRAGMA user_version = 15;
        UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';
        INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
          VALUES ('state.schema.contentVersion', '${version}', 1);
      `);
  }
  return { options, databasePath, before: readSnapshot(legacy) };
}

describe("prepared worker schema migration", () => {
  it("creates node ownership only on first use and retries after an outer rollback", () => {
    const options = {
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-prepared-first-use-") },
    };
    const { db } = openState(options);
    const readTable = () =>
      readRow(db, "SELECT name FROM sqlite_schema WHERE name = 'node_worker_prepared_workspaces'");
    expect(readTable()).toBeUndefined();
    expect(() =>
      writeState(() => {
        ensureWorkspace(db);
        expect(readTable()).toBeDefined();
        throw new Error("registration rejected");
      }, options),
    ).toThrow("registration rejected");
    expect(readTable()).toBeUndefined();
    writeState(() => ensureWorkspace(db), options);
    expect(readTable()).toBeDefined();
    closeState();
    expectRows(openState(options).db, "SELECT * FROM node_worker_prepared_workspaces", []);
  });

  it.each([
    { version: 15, deferred: false },
    { version: 16, deferred: true },
  ])(
    "preserves v$version workers and deferred publication ($deferred)",
    async ({ version, deferred }) => {
      const { options, databasePath, before } = createLegacyWorkers(version, deferred);
      expect(detectMigrations(options)).toContainEqual({
        kind: "prepared-worker-ownership-v17",
        path: databasePath,
      });
      if (deferred) {
        const repaired = await withBackup(options, () => repairState(options));
        expect(repaired.warnings).toEqual([]);
      }
      await withBackup(options, () => openState(options));
      const { db } = openState(options);
      expectRows(
        db,
        "SELECT rowid, * FROM worker_environments",
        before.environments.map((row) => ({
          ...row,
          last_activated_at_ms: null,
          preparation_key: null,
          preparation_demand_at_ms: null,
          preparation_expires_at_ms: null,
          preparation_consumed_at_ms: null,
        })),
      );
      expect(readObligations(db)).toEqual(before.obligations);
      const publishedVersion = deferred ? 15 : OPENCLAW_STATE_SCHEMA_VERSION;
      expectRow(db, "PRAGMA user_version", {
        user_version: publishedVersion,
      });
      expectRow(db, "SELECT schema_version FROM schema_meta", {
        schema_version: publishedVersion,
      });
      if (deferred) {
        expectRow(
          db,
          "SELECT value_json FROM config_machine_state WHERE state_key = ?",
          { value_json: String(OPENCLAW_STATE_SCHEMA_VERSION) },
          "state.schema.contentVersion",
        );
      }
      expectRow(
        db,
        "SELECT name FROM sqlite_schema WHERE name = 'node_worker_prepared_workspaces'",
        undefined,
      );
      const after = readSnapshot(db);
      closeState();
      expect(readSnapshot(openState(options).db)).toEqual(after);
    },
  );

  it("rolls back all v16 migrations and markers after failed doctor repair", async () => {
    const { options, databasePath } = createLegacyWorkers(16);
    const legacy = openNodeSqliteDatabase(databasePath);
    legacy.exec(`CREATE TRIGGER fixture_reject_upgrade BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'prepared migration rollback'); END;`);
    const before = readSnapshot(legacy);
    legacy.close();
    expect(await withBackup(options, () => repairState(options))).toEqual({
      changes: [],
      warnings: [expect.stringContaining("prepared migration rollback")],
    });
    using preserved = openNodeSqliteDatabase(databasePath, { readOnly: true });
    expect(readSnapshot(preserved)).toEqual(before);
  });

  it("retains preparation constraints and consumed bindings on reopen", async () => {
    const { options } = createLegacyWorkers();
    await withBackup(options, () => openState(options));
    const { db } = openState(options);
    const setPreparation = db.prepare(`UPDATE worker_environments SET preparation_key = ?,
      preparation_demand_at_ms = ?, preparation_expires_at_ms = ?, preparation_consumed_at_ms = ?`);
    for (const tuple of [
      [preparationKey, null, 100, null],
      [null, 10, 100, null],
      [preparationKey.toUpperCase(), 10, 100, null],
      [preparationKey, -1, 100, null],
      [preparationKey, 10, 10, null],
      [preparationKey, 10, Number.MAX_SAFE_INTEGER + 1, null],
      [preparationKey, 10, 100, 9],
      [preparationKey, 10, 100, 100],
    ] as const) {
      expect(() => setPreparation.run(...tuple)).toThrow(/CHECK constraint failed/);
    }
    setPreparation.run(preparationKey, 10, 100, 20);
    ensureWorkspace(db);
    db.prepare(`INSERT INTO node_worker_prepared_workspaces (
      preparation_key, cache_key, gateway_namespace, workspace_dir, home_dir, source_manifest_ref, prepared_manifest_ref,
      state, environment_id, session_id, session_key, owner_epoch, created_at_ms, bound_at_ms
    ) VALUES (?, ?, 'gateway', '/prepared/workspace', '/prepared/home', ?, ?,
      'bound', 'environment', 'session', 'agent:main:fixture', 2, 10, 20)`).run(
      preparationKey,
      "c".repeat(64),
      `sha256:${preparationKey}`,
      `sha256:${"d".repeat(64)}`,
    );
    for (const [column, prefix, letter] of [
      ["prepared_manifest_ref", "sha256:", "d"],
      ["cache_key", "", "c"],
    ] as const) {
      const update = db.prepare(`UPDATE node_worker_prepared_workspaces SET ${column} = ?`);
      for (const invalid of [
        null,
        "",
        prefix + letter.repeat(63),
        prefix + letter.toUpperCase().repeat(64),
      ]) {
        expect(() => update.run(invalid)).toThrow(/constraint failed/);
      }
    }
    expect(() => db.exec("UPDATE node_worker_prepared_workspaces SET state = 'available'")).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => db.exec("UPDATE node_worker_prepared_workspaces SET session_key = NULL")).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      db.exec("UPDATE node_worker_prepared_workspaces SET environment_id = NULL"),
    ).toThrow(/NOT NULL constraint failed/);
    db.exec("UPDATE node_worker_prepared_workspaces SET state = 'retired', retired_at_ms = 30");
    const binding = readRow(db, "SELECT * FROM node_worker_prepared_workspaces");
    closeState();
    const reopened = openState(options).db;
    expectRow(reopened, "SELECT * FROM node_worker_prepared_workspaces", binding);
    expectRow(reopened, "SELECT preparation_consumed_at_ms FROM worker_environments", {
      preparation_consumed_at_ms: 20,
    });
  });
});
