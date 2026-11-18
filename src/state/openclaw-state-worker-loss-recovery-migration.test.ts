import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { loadStatePortDescriptor } from "../infra/database-engine/state-port-descriptor.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";
import { migrateBoundedStateSchema } from "./openclaw-state-db-maintenance.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { getOpenClawStatePredecessorSchema } from "./openclaw-state-schema-runtime.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

const directories = useStateDatabaseTempDirs();
function legacy(refusePublication: boolean) {
  const options = { env: { OPENCLAW_STATE_DIR: directories.make("worker-loss-v40-") } };
  const pathname = resolveOpenClawStateSqlitePath(options.env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(getOpenClawStatePredecessorSchema(40));
  db.exec(`PRAGMA user_version = 40;
    INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at) VALUES ('primary', 'global', 40, 1, 1);
    INSERT INTO session_repository_workspaces
      (workspace_id, agent_id, session_key, url, requested_ref, base_commit, branch, revision, created_at_ms, updated_at_ms)
      VALUES ('11111111-1111-4111-8111-111111111111', 'main', 'agent:main:kept', 'https://github.com/example/project.git', 'main', '${"a".repeat(40)}', 'saved/kept', 7, 1, 1);`);
  if (refusePublication) {
    db.exec(
      `CREATE TRIGGER refuse_loss_schema BEFORE UPDATE ON schema_meta BEGIN SELECT RAISE(ABORT, 'fixture loss publication refusal'); END;`,
    );
  }
  return {
    options,
    pathname,
    before: db.prepare("SELECT * FROM session_repository_workspaces").all(),
  };
}

it.each([false, true])(
  "migrates repository loss provenance atomically (rollback=%s)",
  async (rollback) => {
    const { options, pathname, before } = legacy(rollback);
    try {
      const migrate = () =>
        withStateMigrationBackupForTest(options, async () => {
          using scope = new DatabaseSync(pathname);
          await assertSqliteMigrationScopePreserved(
            scope,
            [
              "session_repository_workspaces",
              "worker_session_placements",
              "schema_meta",
              "config_machine_state",
            ],
            () => openOpenClawStateDatabase(options),
          );
        });
      if (rollback) {
        await expect(migrate()).rejects.toThrow("fixture loss publication refusal");
      } else {
        await migrate();
      }
      await closeOpenClawStateDatabaseAsync();
      using db = new DatabaseSync(pathname, { readOnly: true });
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: rollback ? 40 : OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(db.prepare("SELECT * FROM session_repository_workspaces").all()).toEqual(
        rollback ? before : before.map((row) => Object.assign({}, row, { recovery_json: null })),
      );
      const columns = db
        .prepare("PRAGMA table_info(worker_session_placements)")
        .all()
        .map((row) => row.name);
      expect(columns.includes("confirmed_loss_recovery_json")).toBe(!rollback);
      if (!rollback) {
        // ALTER TABLE appends in both engines; migration must match the canonical column ordinals.
        const descriptor = await loadStatePortDescriptor(41);
        expect(columns).toEqual(
          descriptor.tables
            .find((table) => table.name === "worker_session_placements")
            ?.columns.map((column) => column.name),
        );
      }
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  },
);

it("retains the exact v40 PostgreSQL predecessor before adding loss metadata", async () => {
  const before = await loadStatePortDescriptor(40);
  const after = await loadStatePortDescriptor(41);
  const beforeTables = [
    ...before.tables,
    ...(before.fragments ?? []).flatMap((fragment) => fragment.tables),
  ];
  const afterTables = [
    ...after.tables,
    ...(after.fragments ?? []).flatMap((fragment) => fragment.tables),
  ];
  for (const [table, column] of [
    ["session_repository_workspaces", "recovery_json"],
    ["worker_session_placements", "confirmed_loss_recovery_json"],
  ] as const) {
    expect(
      beforeTables.find((entry) => entry.name === table)?.columns.map((entry) => entry.name),
    ).not.toContain(column);
    expect(
      afterTables.find((entry) => entry.name === table)?.columns.map((entry) => entry.name),
    ).toContain(column);
  }
  const migration = stateEngineSchema.postgresMigrations?.find((step) => step.version === 41);
  expect(migration?.sql).toContain("ADD COLUMN recovery_json");
  expect(migration?.sql).toContain("ADD COLUMN confirmed_loss_recovery_json");
});

it("keeps the v40 loss metadata upgrade in the bounded migration path", () => {
  const { options, pathname, before } = legacy(false);
  using db = new DatabaseSync(pathname);
  expect(
    migrateBoundedStateSchema(db, 40, { ...options, versionMigrationOnly: true }),
  ).toHaveLength(1);
  expect(db.prepare("SELECT * FROM session_repository_workspaces").all()).toEqual(
    before.map((row) => Object.assign({}, row, { recovery_json: null })),
  );
  expect(
    db
      .prepare("PRAGMA table_info(worker_session_placements)")
      .all()
      .map((row) => row.name),
  ).toContain("confirmed_loss_recovery_json");
});
