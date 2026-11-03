import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { loadSqliteVecExtension } from "../infra/database-engine/sqlite-vec.js";
import { requireGitCommand } from "../infra/git-exec.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { withEnvAsync } from "../test-utils/env.js";
import { initializeGitBackupRepository, readGitBackupLog } from "./git-backup.js";

export function gitBackupRepository(root: string, name = "repository") {
  const repositoryPath = path.join(root, name);
  const options = { repositoryPath, stateDir: path.join(root, "state") };
  const git = (...args: string[]) => requireGitCommand(repositoryPath, args);
  const file = (...parts: string[]) => path.join(repositoryPath, ...parts);
  return {
    root,
    ...options,
    options,
    git,
    file,
    init: (remote?: string) => initializeGitBackupRepository({ ...options, remote }),
    log: (limit = 10) => readGitBackupLog({ repositoryPath, limit }),
    configureIdentity: async () => {
      await git("config", "user.name", "OpenClaw Backup Test");
      await git("config", "user.email", "backup@example.invalid");
    },
    write: async (relative: string, contents: string) => {
      await fs.mkdir(path.dirname(file(relative)), { recursive: true });
      await fs.writeFile(file(relative), contents);
    },
    commit: async (message: string, ...files: string[]) => {
      await git("add", "--", ...files);
      await git("commit", "-m", message);
    },
  };
}

export function expectDatabaseRows(databasePath: string, queries: Record<string, unknown[]>) {
  using database = new DatabaseSync(databasePath, { readOnly: true });
  for (const [sql, expected] of Object.entries(queries)) {
    expect(database.prepare(sql).all(), sql).toEqual(expected);
  }
}

export async function withBackupStateEnv<T>(
  values: Parameters<typeof withEnvAsync>[0],
  run: () => Promise<T>,
): Promise<T> {
  return withEnvAsync(values, async () => {
    await using state = { run, [Symbol.asyncDispose]: closeOpenClawStateDatabaseAsync };
    return await state.run();
  });
}

export function createStateDatabaseFixture(root: string) {
  const stateDir = path.join(root, "state");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  closeOpenClawStateDatabaseForTest();
  return {
    stateDir,
    database: { path: resolveOpenClawStateSqlitePath(env), identity: { role: "global" as const } },
  };
}

const schemaMeta = `CREATE TABLE schema_meta (
  meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL,
  agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;`;

export async function createFormatFixture(databasePath: string): Promise<void> {
  using database = new DatabaseSync(databasePath, { allowExtension: true });
  await loadSqliteVecExtension({ db: database });
  database.exec(`
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
      ${schemaMeta}
      INSERT INTO schema_meta VALUES
        ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL, NULL, 1, 1);
      CREATE TABLE device_auth_tokens (token TEXT) STRICT;
      INSERT INTO device_auth_tokens VALUES ('secret-token');
      ${extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "channel_pairing_requests")}
      INSERT INTO channel_pairing_requests VALUES ('telegram', 'default', 'r', 'code', 'now', 'now', NULL);
      ${extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "device_pairing_join_codes")}
      INSERT INTO device_pairing_join_codes VALUES ('join-code', '{"bootstrapToken":"secret"}', 1, 2);
      CREATE TABLE content (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE VIRTUAL TABLE content_fts USING fts5(body, content='content', content_rowid='id');
      INSERT INTO content VALUES (1, 'hello lobster');
      CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[2]);
      CREATE TABLE session_transcript_index_state (id TEXT PRIMARY KEY, cursor INTEGER);
      INSERT INTO session_transcript_index_state VALUES ('main', 99);
      CREATE TABLE session_transcript_fts_rows (session_id TEXT NOT NULL, fts_rowid INTEGER PRIMARY KEY);
      INSERT INTO session_transcript_fts_rows VALUES ('main', 99);
    `);
}

export function createCatalogFixture(databasePath: string) {
  const catalogFor = <T>(fixture: T) => ({
    generatedBy: "openclaw-plugin-model-catalog-v1",
    providers: { fixture },
  });
  const catalog = catalogFor({
    api: "openai-completions",
    apiKey: "provider-secret",
    headers: { Authorization: "Bearer header-secret" },
    models: [{ id: "model", apiKey: "model-secret", headers: { "X-Key": "model-key" } }],
  });
  const malformedHeaders = catalogFor({
    api: "openai-completions",
    apiKey: { value: "provider-secret" },
    headers: ["provider-header-secret"],
    models: [
      { id: "array-header", headers: { Authorization: ["model-header-secret"] } },
      { id: "object-header", headers: { Authorization: { token: "model-secret" } } },
      { id: "string-headers", headers: "model-secret" },
    ],
  });
  const unusableCatalogs = [
    '{"apiKey":"malformed-secret"',
    JSON.stringify(catalogFor(["provider-secret"])),
    JSON.stringify(catalogFor({ models: { Authorization: "model-secret" } })),
    JSON.stringify(catalogFor({ models: ["model-secret"] })),
  ];
  const scopes = ["plugin-model-catalog-v1", "plugin-model-catalog-migration-v1"];
  using database = new DatabaseSync(databasePath);
  database.exec(`
      PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
      ${schemaMeta}
      INSERT INTO schema_meta VALUES
        ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', NULL, 1, 1);
      CREATE TABLE cache_entries (scope TEXT, key TEXT, value_json TEXT);
    `);
  const insert = database.prepare("INSERT INTO cache_entries VALUES (?, ?, ?)");
  for (const scope of scopes) {
    insert.run(scope, "fixture", JSON.stringify(catalog));
    insert.run(scope, "malformed-headers", JSON.stringify(malformedHeaders));
    for (const [index, contents] of unusableCatalogs.entries()) {
      insert.run(scope, `broken-${index}`, contents);
    }
  }
  insert.run("unrelated-cache", "keep", '{"value":"retained"}');
  return { catalog, malformedHeaders, unusableCatalogs, scopes };
}

export async function writeBackupManifest(scopePath: string, agentId: string): Promise<void> {
  await fs.mkdir(scopePath, { recursive: true });
  await fs.writeFile(
    path.join(scopePath, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      identity: { role: "agent", agentId },
      userVersion: 1,
      excludedTables: [],
      tables: {},
    })}\n`,
  );
}
