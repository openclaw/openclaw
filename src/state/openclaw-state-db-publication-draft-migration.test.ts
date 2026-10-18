import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { digestGitHubPublicationRequest } from "../gateway/github-publication-receipt.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { assertSqliteMigrationScopePreserved } from "./sqlite-migration-scope.test-support.js";

const tables = [
  "github_publication_requests",
  "github_personal_publication_requests",
  "github_repository_publication_requests",
];
const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});
function legacyDatabase(absent: boolean, refuse = false) {
  const env = { OPENCLAW_STATE_DIR: directories.make("publication-draft-migration-") };
  const pathname = resolveOpenClawStateSqlitePath(env);
  mkdirSync(path.dirname(pathname), { recursive: true });
  using db = new DatabaseSync(pathname);
  db.exec(OPENCLAW_STATE_SCHEMA_SQL.replaceAll("\n  draft INTEGER,", ""));
  db.exec(`PRAGMA user_version = 27;
    INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
      VALUES ('primary', 'global', 27, 1, 1);`);
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
  const before = db.prepare("SELECT * FROM github_publication_requests").get();
  return { options: { env, path: pathname }, pathname, before };
}

it.each([false, true])(
  "migrates accepted publication intent with lazy tables absent=%s",
  async (absent) => {
    const { options, pathname, before } = legacyDatabase(absent);
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
      { kind: "github-publication-draft-v28", path: pathname },
    ]);
    using witness = new DatabaseSync(pathname);
    const database = await assertSqliteMigrationScopePreserved(
      witness,
      ["schema_meta", "config_machine_state", ...tables],
      () => openOpenClawStateDatabase(options),
    );
    expect(database.db.prepare("SELECT * FROM github_publication_requests").get()).toEqual({
      ...before,
      draft: null,
    });
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
    for (const table of tables.slice(1)) {
      const columns = database.db.prepare(`PRAGMA table_info(${table})`).all();
      expect(columns.some((column) => column.name === "draft")).toBe(!absent);
    }
    await closeOpenClawStateDatabaseAsync();
    const reopened = openOpenClawStateDatabase(options);
    expect(reopened.db.prepare("SELECT * FROM github_publication_requests").get()).toEqual({
      ...before,
      draft: null,
    });
  },
);

it("rolls back the draft columns with a refused schema publication", () => {
  const { options, pathname, before } = legacyDatabase(false, true);
  expect(() => openOpenClawStateDatabase(options)).toThrow("fixture publication refusal");
  using db = new DatabaseSync(pathname);
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 27 });
  expect(db.prepare("SELECT * FROM github_publication_requests").get()).toEqual(before);
  for (const table of tables) {
    expect(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((column) => column.name === "draft"),
    ).toBe(false);
  }
});
