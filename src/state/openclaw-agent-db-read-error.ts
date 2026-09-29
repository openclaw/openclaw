import type { DatabaseSync } from "node:sqlite";
import { sqlitePrimaryResultCode } from "../infra/sqlite-error-diagnostics.js";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "./openclaw-agent-db-schema-compatibility.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { SessionMetadataUnavailableError } from "./session-metadata-unavailable-error.js";

const settledReadOpenFailures = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseSettledReadOpenFailures"),
  () => new WeakSet<object>(),
);

/** Only the native open owner can classify an unreadable store after successful cleanup. */
export function recordOpenClawAgentDatabaseReadOpenFailure(error: unknown): void {
  if (error !== null && typeof error === "object" && sqlitePrimaryResultCode(error) !== undefined) {
    settledReadOpenFailures.add(error);
  }
}

export function isOpenClawAgentDatabaseReadOpenFailure(error: unknown): boolean {
  return error !== null && typeof error === "object" && settledReadOpenFailures.has(error);
}

/** Record schema-owner facts after a failed query or admission, never infer them from error prose. */
export function classifyOpenClawAgentDatabaseReadError(db: DatabaseSync, error: unknown): unknown {
  try {
    const missingTables = collectSqliteSchemaIssues(
      db,
      OPENCLAW_AGENT_SCHEMA_SQL,
      AGENT_SCHEMA_COMPATIBILITY,
    )
      .filter((issue) => issue.code === "missing-table")
      .map((issue) => issue.objectName);
    return missingTables.length > 0
      ? new SessionMetadataUnavailableError("table-missing", { cause: error }, missingTables)
      : error;
  } catch {
    return error;
  }
}
