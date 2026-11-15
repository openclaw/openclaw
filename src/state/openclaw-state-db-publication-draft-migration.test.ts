import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { digestGitHubPublicationRequest } from "../gateway/github-publication-receipt.js";
import { OPENCLAW_STATE_SCHEMA_VERSION as version } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync as closeDatabase,
  detectOpenClawStateDatabaseSchemaMigrations as detectMigrations,
  openOpenClawStateDatabase as openDatabase,
  repairOpenClawStateDatabaseSchema as repairSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  restorePreTemplateStateIdentifiersForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";
import { resolveSchemaMigrationBackupTables } from "./schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

const tables = [
  "github_publication_requests",
  "github_personal_publication_requests",
  "github_repository_publication_requests",
];
type Connection = ReturnType<typeof openDatabase>["db"];
const publication = (db: Connection) =>
  db.prepare("SELECT * FROM github_publication_requests").get();
const hasDraft = (db: Connection, table: string) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((column) => column.name === "draft");
const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeDatabase();
    cleanup();
  });
});
function legacyDatabase(absent: boolean, refuse = false, sourceVersion = 27) {
  const env = { OPENCLAW_STATE_DIR: directories.make("publication-draft-migration-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(OPENCLAW_STATE_SCHEMA_SQL.replaceAll("\n  draft INTEGER,", ""));
  restorePreTemplateStateIdentifiersForTest(db);
  addPreCutoverClientCredentialTablesForTest(db);
  db.exec(`PRAGMA user_version = ${sourceVersion};
    INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
      VALUES ('primary', 'global', ${sourceVersion}, 1, 1);`);
  const digest = digestGitHubPublicationRequest({
    sessionId: "session",
    idempotencyKey: "accepted",
  });
  db.prepare(`INSERT INTO github_publication_requests
    (request_id, idempotency_key, request_digest, session_id, session_key, agent_id,
      worktree_id, repository_fingerprint, identity_source, identity_account_id,
      identity_login, status, branch, created_at_ms, updated_at_ms)
    VALUES ('request', 'accepted', ?, 'session', 'agent:main:publication', 'main',
      'worktree', 'repository', 'system-detected', 42, 'publisher', 'requested', 'topic', 1, 1)`).run(
    digest,
  );
  if (absent) {
    db.exec(
      "DROP TABLE github_personal_publication_requests; DROP TABLE github_repository_publication_requests;",
    );
  }
  if (refuse) {
    db.exec(`CREATE TRIGGER refuse_schema_publication BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'fixture publication refusal'); END;`);
  }
  const before = publication(db);
  return { options: { env, path: pathname }, pathname, before };
}

it.each([false, true])(
  "migrates accepted publication intent with lazy tables absent=%s",
  async (absent) => {
    const { options, pathname, before } = legacyDatabase(absent);
    expect(detectMigrations(options)).toContainEqual({
      kind: "github-publication-draft-v28",
      path: pathname,
    });
    await withStateMigrationBackupForTest(options, async () => {
      using witness = new DatabaseSync(pathname);
      const database = await assertSqliteMigrationScopePreserved(
        witness,
        expectDefined(
          resolveSchemaMigrationBackupTables({
            kind: "state",
            foundVersion: 27,
            supportedVersion: version,
          }),
          "Every executed publication migration step must declare its bounded scope",
        ),
        () => openDatabase(options),
      );
      expect(publication(database.db)).toEqual({ ...before, draft: null });
      expect(database.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
      expect(detectMigrations(options)).toEqual([]);
      for (const table of tables.slice(1)) {
        expect(hasDraft(database.db, table)).toBe(!absent);
      }
      await closeDatabase();
      expect(publication(openDatabase(options).db)).toEqual({ ...before, draft: null });
    });
  },
);

it("rolls back the draft columns with a refused schema publication", async () => {
  const { options, pathname, before } = legacyDatabase(false, true);
  await expect(
    withStateMigrationBackupForTest(options, () => openDatabase(options)),
  ).rejects.toThrow("fixture publication refusal");
  using db = new DatabaseSync(pathname);
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 27 });
  expect(publication(db)).toEqual(before);
  for (const table of tables) {
    expect(hasDraft(db, table)).toBe(false);
  }
});

it.each([false, true])(
  "finishes draft repair after version publication (absent=%s)",
  async (absent) => {
    const { options, pathname, before } = legacyDatabase(absent, false, 28);
    await withStateMigrationBackupForTest(options, () => {
      expect(repairSchema({ ...options, versionMigrationOnly: true }).warnings).toEqual([]);
    });
    using witness = new DatabaseSync(pathname);
    expect(witness.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
    expect(publication(witness)).toEqual(before);
    expect(detectMigrations(options)).toContainEqual({
      kind: "github-publication-draft-v28",
      path: pathname,
    });
    await withStateMigrationBackupForTest(options, async () => {
      const repaired = await assertSqliteMigrationScopePreserved(
        witness,
        ["schema_meta", "config_machine_state", ...tables],
        () => repairSchema(options),
      );
      expect(repaired.warnings).toEqual([]);
      expect(publication(witness)).toEqual({ ...before, draft: null });
      for (const table of tables.slice(1)) {
        expect(hasDraft(witness, table)).toBe(!absent);
      }
      expect(detectMigrations(options)).toEqual([]);
      expect(repairSchema(options).warnings).toEqual([]);
      expect(publication(openDatabase(options).db)).toEqual({ ...before, draft: null });
    });
  },
);
