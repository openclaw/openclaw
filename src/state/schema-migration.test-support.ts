import { constants, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect } from "vitest";
import { restoreDoctorMigrationBackup } from "../commands/doctor-migration-backup-restore.js";
import { createScopedMigrationSnapshot } from "../infra/sqlite-migration-scoped-snapshot.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import {
  ensureOpenClawAgentDatabaseSchema,
  ensureOpenClawAgentSchema,
} from "./openclaw-agent-db-schema.js";
import { captureOpenClawMigrationWitness } from "./openclaw-migration-witness.js";
import { resolveSchemaMigrationBackupTables } from "./schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

export const row = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).get(...params);
export const rows = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).all(...params);
const statistics = (db: DatabaseSync) => rows(db, "SELECT * FROM sqlite_stat1 ORDER BY tbl, idx");
export const agentWitness = (db: DatabaseSync) =>
  captureOpenClawMigrationWitness(db, { role: "agent", agentId: "main" });

export function expectVersion(db: DatabaseSync, version: number) {
  expect(row(db, "PRAGMA user_version")).toEqual({ user_version: version });
  expect(row(db, "SELECT schema_version FROM schema_meta")).toEqual({ schema_version: version });
}

export function seedVersion(db: DatabaseSync, version: number) {
  db.exec(`PRAGMA user_version = ${version};
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
    VALUES ('primary', 'agent', ${version}, 'main', 1, 1);`);
}

export function refuseVersion(db: DatabaseSync, version: number) {
  db.setAuthorizer((action, name, value) =>
    action === constants.SQLITE_PRAGMA && name === "user_version" && value === String(version)
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
}

type Migration = {
  database: DatabaseSync;
  pathname: string;
  env: NodeJS.ProcessEnv;
  scope: string[];
  migrate: () => void;
};

async function migrateWithOutcome(
  { database, env, scope, migrate }: Migration,
  outcome: string,
  target: number,
) {
  if (outcome === "rollback") {
    refuseVersion(database, target);
  }
  try {
    await withAgentDatabaseMaintenanceLease({ env }, async () => {
      await assertSqliteMigrationScopePreserved(database, scope, () => {
        if (outcome === "rollback") {
          expect(migrate).toThrow(/authoriz/u);
        } else {
          migrate();
        }
      });
    });
  } finally {
    database.setAuthorizer(null);
  }
}

async function restoreScopedMigration(
  { database, pathname, env, scope, migrate }: Migration,
  predecessor: number,
  target: number,
  capture: () => unknown,
) {
  const before = capture();
  const beforeStatistics = statistics(database);
  const backupPath = `${pathname}.scoped.bak`;
  expect(
    resolveSchemaMigrationBackupTables({
      kind: "agent",
      foundVersion: predecessor,
      supportedVersion: target,
    }),
  ).toEqual(scope);
  await withAgentDatabaseMaintenanceLease({ env }, async (lease) => {
    await createScopedMigrationSnapshot({
      sourcePath: pathname,
      targetPath: backupPath,
      tables: scope,
      beforePublish: () => lease.assertOwned(),
    });
    migrate();
  });
  database.exec("UPDATE cache_entries SET blob = X'BEEF' WHERE scope = 'unrelated'");
  await assertSqliteMigrationScopePreserved(database, scope, () =>
    restoreDoctorMigrationBackup({ sourcePath: pathname, backupPath, env }),
  );
  expect(capture()).toEqual(before);
  expect(statistics(database)).toEqual(beforeStatistics);
  expect(row(database, "SELECT hex(blob) AS bytes FROM cache_entries")).toEqual({ bytes: "BEEF" });
}

type MigrationFixture = {
  database: DatabaseSync;
  migrate: (outcome?: string) => Promise<void>;
  restore: (capture: () => unknown) => Promise<void>;
};

export function migrationFixture(config: {
  seed: (database: DatabaseSync) => void;
  predecessor: number;
  target: number;
  scope: string[];
  admission?: boolean;
}) {
  return (
    filename: string,
    run: (fixture: MigrationFixture) => Promise<void>,
    location: "root" | "state" = "root",
  ) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pathname = location === "state" ? state.statePath(filename) : state.path(filename);
      using database = new DatabaseSync(pathname);
      config.seed(database);
      const migration = {
        database,
        pathname,
        env: state.env,
        scope: config.scope,
        migrate: () =>
          config.admission
            ? ensureOpenClawAgentDatabaseSchema(database, {
                agentId: "main",
                path: pathname,
                env: state.env,
              })
            : ensureOpenClawAgentSchema(database, "main", pathname, config.target),
      };
      await run({
        database,
        migrate: (outcome = "commit") => migrateWithOutcome(migration, outcome, config.target),
        restore: (capture) =>
          restoreScopedMigration(migration, config.predecessor, config.target, capture),
      });
    });
}
