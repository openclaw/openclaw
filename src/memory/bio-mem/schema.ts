import type { DatabaseSync } from "node:sqlite";

export function ensureBioMemSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bio_episodes (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      user_intent TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      outcome TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      embedding TEXT,
      importance REAL NOT NULL DEFAULT 1.0
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_bio_episodes_session ON bio_episodes(session_key);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_bio_episodes_time ON bio_episodes(timestamp DESC);`,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS bio_semantic_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bio_semantic_edges (
      from_node TEXT NOT NULL,
      to_node TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (from_node, to_node, relation)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bio_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
