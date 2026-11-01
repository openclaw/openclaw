import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createWorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import { loadStatePortDescriptor } from "../infra/database-engine/state-port-descriptor.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { stateEngineSchema } from "./openclaw-state-db-engine.js";
import { stateTemplateNamesMigration } from "./openclaw-state-db-schema-v36-template-names.js";
import { stateWorkerResourceReceiptMigration } from "./openclaw-state-db-schema-v37-resource-receipts.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { inspectStateDatabaseSchema } from "./openclaw-state-schema-preflight.js";
import { withStateMigrationBackupForTest } from "./openclaw-state-schema.test-support.js";
import { createSessionRepositoryWorkspaceStore } from "./session-repository-workspaces.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

const directories = useStateDatabaseTempDirs();
const predecessor = readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-state-schema-v35.sql", import.meta.url),
  "utf8",
);
const workspaceId = "00000000-0000-4000-8000-000000000001";
function legacyDatabase(refuse = false, repositoryPresent = true) {
  const env = { OPENCLAW_STATE_DIR: directories.make("repository-authority-v37-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(predecessor);
  stateTemplateNamesMigration.migrate(db, 35);
  stateWorkerResourceReceiptMigration.migrate(db, 36);
  db.exec(
    "PRAGMA user_version = 37; INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at) VALUES ('primary', 'global', 37, 1, 1);",
  );
  db.exec(
    "INSERT INTO worker_session_placements (session_id, agent_id, session_key, state, created_at_ms, updated_at_ms, state_changed_at_ms) VALUES ('session', 'main', 'agent:main:repository', 'local', 1, 1, 1);",
  );
  db.prepare(
    "INSERT INTO worker_workspace_pending_results (session_id, environment_id, owner_epoch, placement_generation, claim_id, run_id, gateway_instance_id, workspace_accepted_at_ms, staged_result_ref, repository_workspace_id, created_at_ms) VALUES ('session', 'original-environment', 1, 0, 'claim', 'run', 'old-gateway', 42, 'refs/openclaw/worker-results/accepted', ?, 1)",
  ).run(workspaceId);
  if (repositoryPresent) {
    db.prepare(
      "INSERT INTO session_repository_workspaces (workspace_id, agent_id, session_key, url, branch, revision, created_at_ms, updated_at_ms) VALUES (?, 'main', 'agent:main:repository', 'https://example.invalid/repository.git', 'branch', 0, 1, 1)",
    ).run(workspaceId);
  } else {
    db.exec("DROP TABLE session_repository_workspaces");
  }
  if (refuse) {
    db.exec(
      "CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;",
    );
  }
  return {
    options: { env, path: pathname },
    pathname,
    pending: db.prepare("SELECT * FROM worker_workspace_pending_results").get(),
    repository: repositoryPresent
      ? db.prepare("SELECT * FROM session_repository_workspaces").get()
      : undefined,
  };
}

it.each(["runtime", "doctor", "absent-repository"] as const)(
  "migrates v37 through %s without reinterpreting accepted mirror results",
  async (owner) => {
    const f = legacyDatabase(false, owner !== "absent-repository");
    await withStateMigrationBackupForTest(f.options, async () => {
      using scope = new DatabaseSync(f.pathname);
      await assertSqliteMigrationScopePreserved(
        scope,
        [
          "session_repository_workspaces",
          "worker_workspace_pending_results",
          "schema_meta",
          "config_machine_state",
        ],
        () => {
          if (owner === "doctor") {
            expect(repairOpenClawStateDatabaseSchema(f.options).warnings).toEqual([]);
          }
          openOpenClawStateDatabase(f.options);
        },
      );
      const database = openOpenClawStateDatabase(f.options);
      expect(database.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 38 });
      expect(
        runSqliteReadOperationSync(scope, () =>
          inspectStateDatabaseSchema(scope, {
            pathname: f.pathname,
            supportedVersion: 37,
            scope: "state",
            purpose: "runtime",
          }),
        ).schemas.incompatible,
      ).toMatchObject([{ foundVersion: 38, supportedVersion: 37 }]);
      expect(database.db.prepare("SELECT * FROM worker_workspace_pending_results").get()).toEqual({
        ...f.pending,
        repository_disk_authority_json: null,
      });
      if (f.repository) {
        expect(database.db.prepare("SELECT * FROM session_repository_workspaces").get()).toEqual({
          ...f.repository,
          disk_authority_json: null,
        });
      } else {
        expect(
          database.db
            .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_repository_workspaces'")
            .get(),
        ).toBeUndefined();
      }
      await closeOpenClawStateDatabaseAsync();
      const reopened = openOpenClawStateDatabase(f.options);
      const [pending] = await createWorkerSessionPlacementStore({
        database: reopened,
      }).listPendingWorkspaceResultsAsync();
      expect(pending).toMatchObject({
        repositoryWorkspaceId: workspaceId,
        workspaceAcceptedAtMs: 42,
        stagedResultRef: "refs/openclaw/worker-results/accepted",
      });
      expect(pending).not.toHaveProperty("repositoryDiskAuthority");
      if (f.repository) {
        expect(
          await createSessionRepositoryWorkspaceStore({ path: f.pathname }).get(workspaceId),
        ).not.toHaveProperty("diskAuthority");
      }
    });
  },
);

it("rolls back authority DDL and both schema markers on publication refusal", async () => {
  const f = legacyDatabase(true);
  await expect(
    withStateMigrationBackupForTest(f.options, () => openOpenClawStateDatabase(f.options)),
  ).rejects.toThrow("fixture publication refusal");
  await closeOpenClawStateDatabaseAsync();
  using db = new DatabaseSync(f.pathname, { readOnly: true });
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 37 });
  expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
    schema_version: 37,
  });
  expect(db.prepare("SELECT * FROM worker_workspace_pending_results").get()).toEqual(f.pending);
  expect(db.prepare("SELECT * FROM session_repository_workspaces").get()).toEqual(f.repository);
});

it("keeps PostgreSQL predecessor descriptors and optional repository storage aligned", async () => {
  const prior = await loadStatePortDescriptor(37);
  const current = await loadStatePortDescriptor(38);
  const columns = (descriptor: typeof prior, table: string) =>
    [...descriptor.tables, ...(descriptor.fragments ?? []).flatMap((fragment) => fragment.tables)]
      .find((entry) => entry.name === table)
      ?.columns.map((column) => column.name);
  for (const [table, column] of [
    ["session_repository_workspaces", "disk_authority_json"],
    ["worker_workspace_pending_results", "repository_disk_authority_json"],
  ]) {
    expect(columns(prior, table!)).not.toContain(column);
    expect(columns(current, table!)).toContain(column);
  }
  const migration = stateEngineSchema.postgresMigrations!.find(({ version }) => version === 38)!;
  expect(migration.fromSchema.postgres).not.toContain('"repository_disk_authority_json"');
  expect(migration.schema.postgres).toContain('"repository_disk_authority_json" text COLLATE "C",');
  expect(migration.sql).toContain("ALTER TABLE IF EXISTS session_repository_workspaces");
});

it.each(["repository", "pending"] as const)(
  "refuses an empty persisted %s authority instead of restoring mirror semantics",
  async (kind) => {
    const f = legacyDatabase();
    await withStateMigrationBackupForTest(f.options, async () => {
      openOpenClawStateDatabase(f.options);
      await closeOpenClawStateDatabaseAsync();
      const table =
        kind === "repository"
          ? "session_repository_workspaces"
          : "worker_workspace_pending_results";
      const column =
        kind === "repository" ? "disk_authority_json" : "repository_disk_authority_json";
      using offline = new DatabaseSync(f.pathname);
      offline.prepare("UPDATE " + table + " SET " + column + " = ''").run();
      const reopened = openOpenClawStateDatabase(f.options);
      const result =
        kind === "repository"
          ? createSessionRepositoryWorkspaceStore({ path: f.pathname }).get(workspaceId)
          : createWorkerSessionPlacementStore({
              database: reopened,
            }).listPendingWorkspaceResultsAsync();
      await expect(result).rejects.toBeInstanceOf(SyntaxError);
      expect(offline.prepare("SELECT " + column + " AS authority FROM " + table).get()).toEqual({
        authority: "",
      });
    });
  },
);
