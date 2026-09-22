import { existsSync } from "node:fs";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type {
  OpenClawStateDatabaseOptions,
  OpenClawStateDatabaseSchemaMigration,
} from "./openclaw-state-db-contract.js";
import { resolveDatabasePath } from "./openclaw-state-db-maintenance.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "./openclaw-state-db-readonly.js";
import { detectOpenClawStateDatabaseSchemaMigrationsFromDatabase } from "./openclaw-state-db-schema-repair.js";

export function detectOpenClawStateDatabaseSchemaMigrations(
  options: OpenClawStateDatabaseOptions = {},
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): OpenClawStateDatabaseSchemaMigration[] {
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return [];
  }
  if (behavior.artifactPreservingReadOnly) {
    return (
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
        ({ db }) => detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(db, pathname),
        { ...options, path: pathname },
      ) ?? []
    );
  }
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return detectOpenClawStateDatabaseSchemaMigrationsFromDatabase(db, pathname);
  } finally {
    db.close();
  }
}
