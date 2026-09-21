import type { DatabaseSync } from "node:sqlite";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { WORKER_ENVIRONMENT_SESSION_ATTACHMENTS_SCHEMA_SQL } from "./session-attachment-store.js";

const ensuredDatabases = new WeakSet<DatabaseSync>();
const WORKER_ENVIRONMENT_SSH_FALLBACK_PORTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worker_environment_ssh_fallback_ports (
  environment_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0 AND position <= 9),
  port INTEGER NOT NULL CHECK (port >= 1 AND port <= 65535),
  PRIMARY KEY (environment_id, position),
  UNIQUE (environment_id, port),
  FOREIGN KEY (environment_id) REFERENCES worker_environments(environment_id) ON DELETE CASCADE
) STRICT;
`;

/** The worker store prepares its additive companion tables together on first use. */
export function ensureWorkerEnvironmentStoreSchema(database: OpenClawStateDatabase): void {
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; companion row operations use Kysely.
      db.exec(
        `${WORKER_ENVIRONMENT_SSH_FALLBACK_PORTS_SCHEMA_SQL}\n${WORKER_ENVIRONMENT_SESSION_ATTACHMENTS_SCHEMA_SQL}`,
      );
    },
    { database },
    { operationLabel: "worker-environments.companion.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}
