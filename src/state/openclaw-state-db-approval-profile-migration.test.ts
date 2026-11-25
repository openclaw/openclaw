import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadStatePortDescriptor } from "../infra/database-engine/state-port-descriptor.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { getOpenClawStatePredecessorSchema } from "./openclaw-state-schema-runtime.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";
import { resolveSchemaMigrationBackupTables } from "./schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});
const scope = ["config_machine_state", "operator_approvals", "schema_meta"];

function predecessor(refusePublication = false) {
  const env = { OPENCLAW_STATE_DIR: directories.make("approval-profile-v40-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(getOpenClawStatePredecessorSchema(40));
  db.exec(`PRAGMA user_version = 40;
    INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
      VALUES ('primary', 'global', 40, 1, 1);
    INSERT INTO operator_approvals (cursor_id, approval_id, resolution_ref, kind, status,
      presentation_json, requested_by_device_id, requested_by_client_id,
      reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
      created_at_ms, expires_at_ms, updated_at_ms)
      VALUES (7, 'original', '${"r".repeat(43)}', 'exec', 'pending', '{}', 'device', 'client',
        '[]', '[]', 'epoch', 1, 100, 1);
    INSERT INTO diagnostic_events VALUES ('synthetic', 'retained', '{"keep":true}', 1, 1);`);
  if (refusePublication) {
    db.exec(`CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
  }
  return {
    options: { env, path: pathname },
    pathname,
    before: db.prepare("SELECT * FROM operator_approvals").all(),
  };
}

it.each(["runtime", "doctor"] as const)(
  "migrates approval profiles through %s without inventing old requester identities",
  async (owner) => {
    const { options, pathname, before } = predecessor();
    await withStateMigrationBackupForTest(options, async () => {
      using source = new DatabaseSync(pathname);
      const { db } = await assertSqliteMigrationScopePreserved(
        source,
        [...scope, "worker_session_placements"],
        () => {
          if (owner === "doctor") {
            expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
          }
          return openOpenClawStateDatabase(options);
        },
      );
      expect(db.prepare("SELECT * FROM operator_approvals").all()).toEqual(
        before.map((row) => Object.assign({}, row, { requested_by_profile_id: null })),
      );
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        resolveSchemaMigrationBackupTables({
          kind: "state",
          foundVersion: 40,
          supportedVersion: 41,
        }),
      ).toEqual(scope);
      db.prepare(
        "UPDATE operator_approvals SET requested_by_profile_id = ? WHERE approval_id = ?",
      ).run("trusted-profile", "original");
      await closeOpenClawStateDatabaseAsync();
      const reopened = openOpenClawStateDatabase(options);
      expect(
        reopened.db
          .prepare("SELECT cursor_id, requested_by_profile_id FROM operator_approvals")
          .get(),
      ).toEqual({ cursor_id: 7, requested_by_profile_id: "trusted-profile" });
      await closeOpenClawStateDatabaseAsync();
    });
  },
);

it("keeps predecessor PostgreSQL migration and backup descriptors free of the new field", async () => {
  const migration = stateEngineSchema.postgresMigrations?.find((step) => step.version >= 41);
  expect(migration?.fromSchema.postgres).not.toContain("requested_by_profile_id");
  expect(migration?.schema.postgres).toContain('"requested_by_profile_id" text COLLATE "C"');
  for (const version of [24, 39, 40, 41, 42]) {
    const descriptor = await loadStatePortDescriptor(version);
    const table = descriptor.tables.find((entry) => entry.name === "operator_approvals");
    expect(table?.columns.some((column) => column.name === "requested_by_profile_id")).toBe(
      version >= 41,
    );
    expect(descriptor.sqlite.includes("requested_by_profile_id")).toBe(version >= 41);
    expect(descriptor.preData.includes("requested_by_profile_id")).toBe(version >= 41);
  }
});

it("rolls back the added column and version when publication fails", async () => {
  const { options, pathname, before } = predecessor(true);
  await expect(
    withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
  ).rejects.toThrow("fixture publication refusal");
  await closeOpenClawStateDatabaseAsync();
  using db = new DatabaseSync(pathname, { readOnly: true });
  expect(db.prepare("SELECT * FROM operator_approvals").all()).toEqual(before);
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 40 });
});
