import type { DatabaseSync } from "node:sqlite";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";
import { WORKER_ENVIRONMENT_SESSION_ATTACHMENTS_SCHEMA_SQL } from "./session-attachment-store.js";

const ensuredDatabases = new WeakSet<DatabaseSync>();
const WORKER_ENVIRONMENT_SSH_FALLBACK_PORTS_SCHEMA_SQL = getOpenClawStateFeatureSchemaSql(
  "worker_environment_ssh_fallback_ports",
);

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
  const remember = () => {
    ensuredDatabases.add(database.db);
  };
  if (!deferSqlitePostCommitPublication(database.db, remember)) {
    remember();
  }
}
