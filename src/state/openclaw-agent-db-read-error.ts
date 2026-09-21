import type { DatabaseSync } from "node:sqlite";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "./openclaw-agent-db-schema-compatibility.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export class SessionMetadataUnavailableError extends Error {
  constructor(
    readonly reason: "schema-missing" | "table-missing",
    options?: ErrorOptions,
    readonly missingTables: readonly string[] = [],
  ) {
    super(
      `Session metadata unavailable (${[reason, ...missingTables].join(": ")}); retry after the agent store is ready.`,
      options,
    );
    this.name = "SessionMetadataUnavailableError";
  }
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
