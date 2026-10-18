import { existsSync } from "node:fs";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { openSqliteReadOnlyDatabase } from "../infra/sqlite-snapshot-source.js";
import type {
  OpenClawStateDatabaseOptions,
  OpenClawStateDatabaseSchemaMigration,
} from "./openclaw-state-db-contract.js";
import { isStatePostgres } from "./openclaw-state-db-engine.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "./openclaw-state-db-readonly.js";
import { detectOpenClawStateDatabaseSchemaMigrationsFromDatabase } from "./openclaw-state-db-schema-repair.js";
import { resolveDatabasePath } from "./openclaw-state-db.paths.js";

export function detectOpenClawStateDatabaseSchemaMigrations(
  options: OpenClawStateDatabaseOptions = {},
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): OpenClawStateDatabaseSchemaMigration[] {
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return [];
  }
  if (isStatePostgres() || behavior.artifactPreservingReadOnly) {
    return (
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
        ({ db }) => {
          if (isPostgresSqlConnection(db)) {
            // PostgreSQL's engine owner admits its migrations; these inspect legacy SQLite layouts.
            return [];
          }
          return detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(db, pathname);
        },
        { ...options, path: pathname },
      ) ?? []
    );
  }
  const db = openSqliteReadOnlyDatabase(pathname, { readOnly: true });
  try {
    return detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(db, pathname);
  } finally {
    db.close();
  }
}
