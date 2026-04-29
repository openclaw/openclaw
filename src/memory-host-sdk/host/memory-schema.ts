import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../../infra/errors.js";

export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  agentId: string;
  embeddingCacheTable: string;
  cacheEnabled: boolean;
  ftsTable: string;
  ftsEnabled: boolean;
  ftsTokenizer?: "unicode61" | "trigram";
}): { ftsAvailable: boolean; ftsError?: string } {
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  ensureFilesTable(params.db, params.agentId);
  ensureChunksTable(params.db, params.agentId);
  if (params.cacheEnabled) {
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      );
    `);
    params.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${params.embeddingCacheTable}(updated_at);`,
    );
  }

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      const tokenizer = params.ftsTokenizer ?? "unicode61";
      const tokenizeClause = tokenizer === "trigram" ? `, tokenize='trigram case_sensitive 0'` : "";
      const existingFtsColumns = readColumns(params.db, params.ftsTable);
      const shouldRebuildFts = existingFtsColumns.size > 0 && !existingFtsColumns.has("agent_id");
      if (shouldRebuildFts) {
        params.db.exec(`DROP TABLE IF EXISTS ${params.ftsTable}`);
      }
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${params.ftsTable} USING fts5(\n` +
          `  text,\n` +
          `  id UNINDEXED,\n` +
          `  agent_id UNINDEXED,\n` +
          `  path UNINDEXED,\n` +
          `  source UNINDEXED,\n` +
          `  model UNINDEXED,\n` +
          `  start_line UNINDEXED,\n` +
          `  end_line UNINDEXED\n` +
          `${tokenizeClause});`,
      );
      if (shouldRebuildFts) {
        rebuildMemoryFtsFromChunks({ db: params.db, ftsTable: params.ftsTable });
      }
      ftsAvailable = true;
    } catch (err) {
      const message = formatErrorMessage(err);
      ftsAvailable = false;
      ftsError = message;
    }
  }

  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_agent_source ON files(agent_id, source);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_agent_path ON chunks(agent_id, path);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_agent_source ON chunks(agent_id, source);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_agent_model ON chunks(agent_id, model);`);

  return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
}

function readColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?`)
    .get(table) as { name?: string } | undefined;
  return row?.name === table;
}

function runMigration(db: DatabaseSync, body: () => void): void {
  db.exec("BEGIN");
  try {
    body();
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function ensureFilesTable(db: DatabaseSync, agentId: string): void {
  if (!tableExists(db, "files")) {
    db.exec(`
      CREATE TABLE files (
        agent_id TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (agent_id, path, source)
      );
    `);
    return;
  }

  ensureColumn(db, "files", "agent_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
  db.prepare(`UPDATE files SET agent_id = ? WHERE agent_id IS NULL OR agent_id = ''`).run(agentId);

  const pkColumns = (
    db.prepare(`PRAGMA table_info(files)`).all() as Array<{ name: string; pk: number }>
  )
    .filter((row) => row.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);
  if (pkColumns.join(",") === "agent_id,path,source") {
    return;
  }

  runMigration(db, () => {
    db.exec(`ALTER TABLE files RENAME TO files_legacy_namespace`);
    db.exec(`
      CREATE TABLE files (
        agent_id TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (agent_id, path, source)
      );
    `);
    db.prepare(
      `INSERT OR REPLACE INTO files (agent_id, path, source, hash, mtime, size)
       SELECT CASE WHEN agent_id IS NULL OR agent_id = '' THEN ? ELSE agent_id END,
              path, source, hash, mtime, size
         FROM files_legacy_namespace`,
    ).run(agentId);
    db.exec(`DROP TABLE files_legacy_namespace`);
  });
}

function ensureChunksTable(db: DatabaseSync, agentId: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  ensureColumn(db, "chunks", "agent_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");
  db.prepare(`UPDATE chunks SET agent_id = ? WHERE agent_id IS NULL OR agent_id = ''`).run(agentId);
}

function rebuildMemoryFtsFromChunks(params: { db: DatabaseSync; ftsTable: string }): void {
  params.db.exec(
    `INSERT INTO ${params.ftsTable} (text, id, agent_id, path, source, model, start_line, end_line)
     SELECT text, id, agent_id, path, source, model, start_line, end_line FROM chunks`,
  );
}

function ensureColumn(
  db: DatabaseSync,
  table: "files" | "chunks",
  column: string,
  definition: string,
): void {
  const columns = readColumns(db, table);
  if (columns.has(column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
