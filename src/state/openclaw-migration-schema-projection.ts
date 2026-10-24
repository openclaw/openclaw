import { parseSqliteTableDefinition } from "../infra/sqlite-schema-contract-assembly.js";
import { getCanonicalSqliteNamedIndexContracts } from "../infra/sqlite-schema-contract.js";
import { LEGACY_CANONICAL_VALIDATION_TRIGGER_NAMES } from "./openclaw-agent-canonical-validation-migration.js";
import {
  AGENT_INDEX_RETIREMENT_SCHEMA_VERSION,
  AGENT_MEMORY_REVISION_SCHEMA_VERSION,
  AGENT_WRITE_LAYOUT_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-db-schema-helpers.js";
import { AGENT_JSON_PREDICATE_COLUMNS } from "./openclaw-agent-json-predicate-schema.js";
import { LEGACY_MEMORY_REVISION_TRIGGER_NAMES } from "./openclaw-agent-memory-revision-migration.js";
import { withoutOutboxEnqueueSequence } from "./openclaw-agent-outbox-sequence-migration.js";
import type { OpenClawMigrationWitness } from "./openclaw-migration-witness-contract.js";

export const derivedMigrationColumns = new Map<string, ReadonlySet<string>>(
  Object.entries({
    ...AGENT_JSON_PREDICATE_COLUMNS,
    session_windows: ["row_transcript_json", "row_transcript_updated_at"],
    trajectory_runtime_events: ["event_utf8_bytes", "event_payload", "event_codec"],
  }).map(([table, columns]) => [table, new Set<string>(columns)]),
);

// Schemas 25 and 26 change these derived facts only. persistAgentSchemaMetadata also
// publishes the target app version and timestamp; payload and creation time stay exact.
export function migrationColumn(
  role: OpenClawMigrationWitness["role"],
  table: string,
  column: string,
) {
  return !(
    role === "agent" &&
    ((table === "schema_meta" &&
      ["schema_version", "app_version", "updated_at"].includes(column)) ||
      (table === "session_key_contract" && column === "canonical_ready") ||
      derivedMigrationColumns.get(table)?.has(column))
  );
}

/** Pure normalization of canonically admitted schema objects for migration evidence. */
export function createMigrationSchemaProjection(
  role: OpenClawMigrationWitness["role"],
  schemaVersion: number,
  tableKinds: ReadonlyMap<string, { withoutRowid: boolean; strict: boolean }>,
) {
  const questionIndexes =
    role === "agent" && schemaVersion === 33
      ? new Set(
          getCanonicalSqliteNamedIndexContracts(getOpenClawAgentMigrationSchema(33))
            .filter((index) => index.tableName === "session_questions")
            .map((index) => index.name),
        )
      : new Set<string>();
  return (object: { type: string; name: string; tbl_name: string; sql: string | null }) => {
    // Schema 33 adds this canonically validated table and its indexes only.
    if (
      role === "agent" &&
      schemaVersion === 33 &&
      object.tbl_name === "session_questions" &&
      ((object.type === "table" && object.name === "session_questions") ||
        (object.type === "index" &&
          (questionIndexes.has(object.name) ||
            (object.name === "sqlite_autoindex_session_questions_1" && object.sql === null))))
    ) {
      return undefined;
    }
    // Admission validates canonical objects before migration-only normalization.
    const indexKey = `${object.tbl_name}.${object.name}`;
    if (
      role === "agent" &&
      ((schemaVersion === 24 &&
        object.type === "trigger" &&
        LEGACY_CANONICAL_VALIDATION_TRIGGER_NAMES.includes(object.name)) ||
        (schemaVersion < AGENT_MEMORY_REVISION_SCHEMA_VERSION &&
          object.type === "trigger" &&
          LEGACY_MEMORY_REVISION_TRIGGER_NAMES.includes(object.name)) ||
        (object.type === "index" &&
          (indexKey === "session_windows.idx_agent_session_windows_conversation" ||
            indexKey === "trajectory_runtime_events.idx_agent_trajectory_runtime_run" ||
            (schemaVersion < AGENT_INDEX_RETIREMENT_SCHEMA_VERSION &&
              (indexKey === "session_nodes.idx_agent_session_nodes_last_interaction_at" ||
                indexKey === "session_reactions.idx_agent_session_reactions_message")) ||
            (schemaVersion < AGENT_WRITE_LAYOUT_SCHEMA_VERSION &&
              (indexKey === "transcript_event_identities.idx_agent_transcript_event_parent" ||
                (indexKey === "memory_entry_origins.sqlite_autoindex_memory_entry_origins_1" &&
                  object.sql === null))))))
    ) {
      return undefined;
    }
    if (
      role === "agent" &&
      object.type === "table" &&
      (object.name === "session_key_contract" ||
        object.name === "memory_entry_origins" ||
        derivedMigrationColumns.has(object.name))
    ) {
      const definition = parseSqliteTableDefinition(
        object.name === "context_engine_turn_outbox" && object.sql
          ? withoutOutboxEnqueueSequence(object.sql)
          : object.sql,
        object.name,
      );
      for (const column of definition.columns.keys()) {
        if (!migrationColumn(role, object.name, column)) {
          definition.columns.delete(column);
        }
      }
      return {
        ...object,
        sql: {
          columns: [...definition.columns],
          constraints: definition.constraints,
          ...tableKinds.get(object.name),
          ...(object.name === "memory_entry_origins" ? { withoutRowid: false } : {}),
        },
      };
    }
    return object;
  };
}
