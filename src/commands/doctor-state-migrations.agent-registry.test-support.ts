import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";

export async function createLegacyAgentDatabaseRegistry(stateDir: string): Promise<string> {
  const { path: stateDatabasePath } = openOpenClawStateDatabase({
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
  await closeOpenClawStateDatabaseByPathAsync(stateDatabasePath);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(stateDatabasePath);
  try {
    db.exec(`
      DROP TABLE agent_databases;
      CREATE TABLE agent_databases (
        agent_id TEXT NOT NULL PRIMARY KEY,
        path TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        size_bytes INTEGER
      );
      INSERT INTO agent_databases (
        agent_id,
        path,
        schema_version,
        last_seen_at,
        size_bytes
      ) VALUES (
        'worker-1',
        '/legacy/worker-1/openclaw-agent.sqlite',
        1,
        10,
        20
      );
    `);
  } finally {
    db.close();
  }
  return stateDatabasePath;
}
