import type { DatabaseSync } from "node:sqlite";
import { canonicalSessionValidationSchemaSql } from "./openclaw-agent-canonical-validation-schema.js";
import { agentDatabaseLifecycle as cache } from "./openclaw-agent-db-lifecycle.js";

/** Remove only the schema owner's future projection before carving a historical database. */
export function removeCanonicalValidationFromHistoricalAgentFixture(database: DatabaseSync): void {
  const definitions = [
    ...canonicalSessionValidationSchemaSql().matchAll(
      /^CREATE (TABLE|TRIGGER) IF NOT EXISTS ([a-z_]+)\b/gm,
    ),
  ];
  // Drop triggers before their pending table; unrelated fixture dependents remain intact.
  for (const match of definitions.toReversed()) {
    const kind = match[1];
    const name = match[2];
    if ((kind !== "TABLE" && kind !== "TRIGGER") || typeof name !== "string") {
      throw new Error("Invalid canonical-validation schema fixture definition");
    }
    database.exec(`DROP ${kind} IF EXISTS "${name}"`);
  }
}

/** List process-held agent databases without opening or inspecting fixture state. */
export function listOpenClawAgentDatabasesForTest(): Array<{ agentId: string; path: string }> {
  return [...cache.databases.values()]
    .filter((database) => database.db.isOpen)
    .map((database) => ({ agentId: database.agentId, path: database.path }))
    .toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) || left.path.localeCompare(right.path),
    );
}
