import type { DatabaseSync } from "node:sqlite";
import {
  collectSqliteSchemaIssues,
  createSqliteTableContractReader,
  type SqliteSchemaIssue,
} from "../infra/sqlite-schema-contract.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import {
  getOpenClawStateRuntimeSchema,
  isOpenClawStateFirstUseSchemaIssue,
  isOpenClawStateStartupRepairableSchemaIssue,
  OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
  STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
} from "./openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

function deduplicateSchemaIssues(issues: readonly SqliteSchemaIssue[]): SqliteSchemaIssue[] {
  return [
    ...new Map(
      issues.map((issue) => [`${issue.code}\0${issue.objectName}`, issue] as const),
    ).values(),
  ];
}

export function inspectCurrentStateStartupSchema(
  database: DatabaseSync,
  databasePath: string,
  foundVersion: number,
) {
  assertOpenClawStateDatabaseOwner(database, { pathname: databasePath });
  const metadata = database
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
    .get();
  if (metadata?.schema_version !== foundVersion) {
    throw new Error(
      `OpenClaw state database ${databasePath} metadata schema version ${typeof metadata?.schema_version === "number" ? metadata.schema_version : "invalid"} does not match ${foundVersion}.`,
    );
  }
  // Both policies inspect the same private or immutable snapshot; later opens read fresh facts.
  const readTable = createSqliteTableContractReader(database);
  const issues = deduplicateSchemaIssues([
    ...collectSqliteSchemaIssues(
      database,
      OPENCLAW_STATE_SCHEMA_SQL,
      OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
      readTable,
    ),
    ...collectSqliteSchemaIssues(
      database,
      getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
      STATE_PERSISTENT_SCHEMA_COMPATIBILITY,
      readTable,
    ),
  ]);
  return {
    blockingIssues: issues.filter(
      (issue) =>
        !isOpenClawStateStartupRepairableSchemaIssue(issue) &&
        !isOpenClawStateFirstUseSchemaIssue(issue),
    ),
    startupRepairableIssues: issues.filter(isOpenClawStateStartupRepairableSchemaIssue),
  };
}
