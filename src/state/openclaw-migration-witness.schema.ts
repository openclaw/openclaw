import { z } from "zod";
import { AGENT_CREATION_OPERATIONS_SCHEMA_VERSION } from "./openclaw-agent-creation-operations-schema.js";
import { AGENT_COLD_ARCHIVE_CHUNKS_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { AGENT_JSON_PREDICATE_COLUMNS } from "./openclaw-agent-json-predicate-schema.js";
import { DURABLE_QUESTIONS_SCHEMA_VERSION } from "./openclaw-agent-questions-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";

export const witnessIdentifierSchema = z.string().max(256);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const headerInteger = z.number().int().min(-2147483648).max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const registryRowSchema = z
  .object({
    store: digest,
    locator: digest,
    schemaVersion: headerInteger,
    expectedSchemaVersion: headerInteger,
    sha256: digest,
  })
  .strict();
const tableSchema = z
  .object({
    name: witnessIdentifierSchema,
    columns: z.array(witnessIdentifierSchema).min(1).max(256),
    rowCount: count,
    sha256: digest,
    migrationSha256: digest,
    registryRows: z.array(registryRowSchema).max(4096).optional(),
  })
  .strict();
export const witnessSchema = z
  .object({
    version: z.literal(1),
    role: z.enum(["agent", "global", "sqlite"]),
    schemaVersion: headerInteger,
    applicationId: headerInteger,
    agentId: witnessIdentifierSchema.min(1).nullable(),
    schemaSha256: digest,
    migrationSchemaSha256: digest,
    registryMigrationBinding: digest.nullable(),
    tables: z.array(tableSchema).max(512),
    gaps: z.object({ missingWindows: count, emptyWindows: count }).strict(),
  })
  .strict();

export type OpenClawMigrationWitness = z.infer<typeof witnessSchema>;

export const derivedMigrationColumns = new Map<string, ReadonlySet<string>>(
  Object.entries({
    ...AGENT_JSON_PREDICATE_COLUMNS,
    session_windows: ["row_transcript_json", "row_transcript_updated_at"],
    trajectory_runtime_events: ["event_utf8_bytes", "event_payload", "event_codec"],
  }).map(([table, columns]) => [table, new Set<string>(columns)]),
);

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error("Migration witness contains duplicate identities");
  }
}

/** Treat loaded evidence as untrusted; an empty or unsupported owner projection cannot pass. */
export function parseOpenClawMigrationWitness(value: unknown): OpenClawMigrationWitness {
  const witness = witnessSchema.parse(value);
  assertUnique(witness.tables.map((table) => table.name));
  for (const table of witness.tables) {
    const isRegistryTable =
      witness.role === "global" &&
      witness.registryMigrationBinding &&
      table.name === "agent_databases";
    assertUnique(table.columns);
    if (table.registryRows) {
      assertUnique(table.registryRows.map((row) => row.locator));
    }
    if (table.registryRows && !isRegistryTable) {
      throw new Error("Migration witness has unexpected registry observations");
    }
    if (
      !(
        witness.role === "agent" &&
        (["schema_meta", "session_key_contract", "memory_entry_origins"].includes(table.name) ||
          derivedMigrationColumns.has(table.name))
      ) &&
      !isRegistryTable &&
      table.sha256 !== table.migrationSha256
    ) {
      throw new Error("Migration witness has an unsupported content transformation");
    }
  }
  if (
    (witness.role === "agent" &&
      (witness.agentId === null ||
        ![24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41].includes(
          witness.schemaVersion,
        ))) ||
    (witness.role !== "agent" && witness.agentId !== null) ||
    (witness.role !== "agent" && witness.schemaSha256 !== witness.migrationSchemaSha256) ||
    (witness.role !== "global" && witness.registryMigrationBinding !== null) ||
    (witness.role !== "agent" &&
      (witness.gaps.missingWindows !== 0 || witness.gaps.emptyWindows !== 0)) ||
    (witness.role === "global" && witness.schemaVersion !== OPENCLAW_STATE_SCHEMA_VERSION)
  ) {
    throw new Error("Unsupported migration witness owner or schema version");
  }
  const required =
    witness.role === "agent"
      ? [
          "schema_meta",
          "session_nodes",
          "session_windows",
          "transcript_events",
          "session_key_contract",
          "session_canonical_validation_pending",
          ...(witness.schemaVersion >= DURABLE_QUESTIONS_SCHEMA_VERSION
            ? ["session_questions"]
            : []),
          ...(witness.schemaVersion >= AGENT_CREATION_OPERATIONS_SCHEMA_VERSION
            ? ["session_creation_operations"]
            : []),
          ...(witness.schemaVersion >= AGENT_COLD_ARCHIVE_CHUNKS_SCHEMA_VERSION
            ? ["session_transcript_cold_archive_chunks"]
            : []),
        ]
      : witness.role === "global"
        ? ["schema_meta", "config_machine_state"]
        : [];
  if (required.some((name) => !witness.tables.some((table) => table.name === name))) {
    throw new Error("Migration witness is missing its owner's required tables");
  }
  return witness;
}
