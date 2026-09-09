import type { DatabaseSync } from "node:sqlite";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import type { DB } from "./openclaw-agent-db.generated.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export type SessionGroupsDatabase = Pick<DB, "session_groups" | "session_group_state">;
const SESSION_GROUPS_SCHEMA_SQL = ["session_groups", "session_group_state"]
  .map((table) => {
    const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const endMarker = "\n) STRICT;";
    const end = start < 0 ? -1 : OPENCLAW_AGENT_SCHEMA_SQL.indexOf(endMarker, start);
    if (start < 0 || end < 0) {
      throw new Error(`Canonical agent schema is missing ${table}`);
    }
    return OPENCLAW_AGENT_SCHEMA_SQL.slice(start, end + endMarker.length);
  })
  .join("\n");
/** Call inside the canonical agent owner's write transaction. */
export function ensureSessionGroupsSchema(db: DatabaseSync): void {
  if (!db.isTransaction) {
    throw new Error("Session-group schema requires an agent write transaction");
  }
  // Do not cache before commit: a rolled-back first write must recreate both tables.
  db.exec(SESSION_GROUPS_SCHEMA_SQL); // sqlite-allow-raw -- Canonical first-use DDL.
  assertSqliteSchemaContains(db, "agent session groups", SESSION_GROUPS_SCHEMA_SQL);
}

export function parseSessionGroupSectionOrder(json: string): string[] {
  const order: unknown = JSON.parse(json);
  if (
    !Array.isArray(order) ||
    !order.every((section): section is string => typeof section === "string")
  ) {
    throw new Error("Invalid session-group section order");
  }
  return order;
}
