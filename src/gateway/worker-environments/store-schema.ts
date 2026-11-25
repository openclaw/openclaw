import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { createSqliteSchemaEnsurer } from "../../infra/sqlite-schema-ensure.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../../infra/sqlite-schema-facts.js";
import { ensureStatePostgresFragment } from "../../state/openclaw-state-db-engine.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";
import { WORKER_ENVIRONMENT_SESSION_ATTACHMENTS_SCHEMA_SQL } from "./session-attachment-store.js";

const ensuredDatabases = new WeakMap<EngineConnection, SqliteSchemaFacts>();
const WORKER_ENVIRONMENT_SSH_FALLBACK_PORTS_SCHEMA_SQL = getOpenClawStateFeatureSchemaSql(
  "worker_environment_ssh_fallback_ports",
);
const ensureStoreSchema = createSqliteSchemaEnsurer(
  () =>
    `${WORKER_ENVIRONMENT_SSH_FALLBACK_PORTS_SCHEMA_SQL}\n${WORKER_ENVIRONMENT_SESSION_ATTACHMENTS_SCHEMA_SQL}`,
  {
    tables: ["worker_environment_ssh_fallback_ports", "worker_environment_session_attachments"],
    indexes: ["worker_environment_session_attachments_session_key"],
  },
);

/** The worker store prepares its companion tables inside its mutation transaction. */
export function ensureWorkerEnvironmentStoreSchema(database: OpenClawStateDatabase): void {
  const facts = getAdmittedSqliteSchemaFacts(database.db);
  if (facts && ensuredDatabases.get(database.db) === facts) {
    return;
  }
  if (isPostgresSqlConnection(database.db)) {
    ensureStatePostgresFragment(database.db, "worker_environment_ssh_fallback_ports");
    ensureStatePostgresFragment(database.db, "worker_environment_session_attachments");
  } else {
    ensureStoreSchema(database.db);
  }
  deferSqlitePostCommitPublication(database.db, () => {
    const initialized = getAdmittedSqliteSchemaFacts(database.db);
    if (initialized) {
      ensuredDatabases.set(database.db, initialized);
    }
  });
}
