import type { Hash } from "node:crypto";
import { AGENT_PROGRESS_WORK_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { AGENT_JSON_PREDICATE_COLUMNS } from "./openclaw-agent-json-predicate-schema.js";
import { PROGRESS_CARD_WORK_COLUMNS } from "./openclaw-agent-schema-history.js";
import type { OpenClawMigrationWitness } from "./openclaw-migration-witness.schema.js";

export const progressTable = "session_progress_cards";
export const progressWorkColumns = new Set<string>(
  PROGRESS_CARD_WORK_COLUMNS.map(([name]) => name),
);

export function assertMigrationWitnessProgressColumns(
  table: OpenClawMigrationWitness["tables"][number],
  role: OpenClawMigrationWitness["role"],
): void {
  if (table.progressWorkColumns) {
    if (
      new Set(table.progressWorkColumns.map(({ name }) => name)).size !==
      table.progressWorkColumns.length
    ) {
      throw new Error("Migration witness contains duplicate work columns");
    }
    if (
      role !== "agent" ||
      table.name !== progressTable ||
      JSON.stringify(table.progressWorkColumns.map(({ name }) => name).toSorted()) !==
        JSON.stringify(table.columns.filter((name) => progressWorkColumns.has(name)).toSorted())
    ) {
      throw new Error("Migration witness has invalid retained work observations");
    }
  } else if (
    role === "agent" &&
    table.name === progressTable &&
    table.columns.some((name) => progressWorkColumns.has(name))
  ) {
    throw new Error("Migration witness is missing retained work observations");
  }
}

/** Existing authoritative columns stay exact on every crossing; only schema 39 may add defaults. */
export function assertMigrationWitnessProgressPreserved(
  original: OpenClawMigrationWitness,
  current: OpenClawMigrationWitness,
): void {
  const before = original.tables.find((table) => table.name === progressTable);
  const after = current.tables.find((table) => table.name === progressTable);
  const oldColumns = new Map(before?.progressWorkColumns?.map((column) => [column.name, column]));
  const newColumns = new Map(after?.progressWorkColumns?.map((column) => [column.name, column]));
  const addsWork =
    original.schemaVersion < AGENT_PROGRESS_WORK_SCHEMA_VERSION &&
    current.schemaVersion >= AGENT_PROGRESS_WORK_SCHEMA_VERSION;
  for (const name of new Set([...oldColumns.keys(), ...newColumns.keys()])) {
    const old = oldColumns.get(name),
      next = newColumns.get(name);
    if (old ? old.sha256 !== next?.sha256 : !addsWork || !next?.allDefault) {
      throw new Error(
        `Migration changed or lost retained database content: ${progressTable}.${name}`,
      );
    }
  }
  if (addsWork && after && newColumns.size !== PROGRESS_CARD_WORK_COLUMNS.length) {
    throw new Error("Migration changed or lost retained work columns");
  }
}

export const derivedMigrationColumns = new Map<string, ReadonlySet<string>>(
  Object.entries({
    ...AGENT_JSON_PREDICATE_COLUMNS,
    session_windows: ["row_transcript_json", "row_transcript_updated_at"],
    trajectory_runtime_events: ["event_utf8_bytes", "event_payload", "event_codec"],
  }).map(([table, columns]) => [table, new Set<string>(columns)]),
);

// Schemas 25 and 26 change these derived facts only. persistAgentSchemaMetadata also
// publishes the target app version and timestamp; payload and creation time stay exact.
// Work columns have separate authoritative digests, not a derived-data exemption.
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
      derivedMigrationColumns.get(table)?.has(column) ||
      (table === progressTable && progressWorkColumns.has(column)))
  );
}

export function hashCell(hash: Hash, type: unknown, value: unknown): void {
  if (
    typeof type !== "string" ||
    (value !== null && typeof value !== "string" && !(value instanceof Uint8Array))
  ) {
    throw new Error("Unreadable migration witness cell");
  }
  const bytes =
    value === null ? Buffer.alloc(0) : typeof value === "string" ? Buffer.from(value) : value;
  hash.update(`${type}:${bytes.byteLength}:`).update(bytes).update(";");
}
