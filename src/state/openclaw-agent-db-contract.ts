import type { EngineConnection } from "../infra/sql-connection.js";
import type { SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import type {
  DatabaseFileIdentity,
  DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";

export { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
export const AGENT_COLD_ARCHIVE_CHUNKS_SCHEMA_VERSION = 37;
export const AGENT_VECTOR_SEARCH_SCHEMA_VERSION = 33;
export const AGENT_VECTOR_DECODER_SCHEMA_VERSION = 32;
export const AGENT_MEMORY_REVISION_SCHEMA_VERSION = 31;
export const AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION = 30;
export const AGENT_INDEX_RETIREMENT_SCHEMA_VERSION = 29;
export const AGENT_WRITE_LAYOUT_SCHEMA_VERSION = 28;
export const AGENT_OUTBOX_SEQUENCE_SCHEMA_VERSION = 27;
export const AGENT_JSON_PREDICATE_SCHEMA_VERSION = 26;
export const CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION = 25;
export const AGENT_STORAGE_SCHEMA_VERSION = 23;
export const TRANSCRIPT_FTS_ROW_SCHEMA_VERSION = 22;
export const AGENT_MEDIA_SCHEMA_VERSION = 17;
export const MEDIA_ROWS_MIGRATION_META_KEY = "media-persistence-rows-v1";
export const CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION = 21;
// Bound the disk work shared by startup inspection, admission, and canonical preparation.
export { AGENT_DATABASE_PREFLIGHT_CONCURRENCY } from "../infra/worker-pool-sizing.js";
// Bounds startup session reconciliation for large fleets without letting one slow store hold every slot.
export const AGENT_DATABASE_PREPARATION_CONCURRENCY = 4;

export type OpenClawAgentDatabase = {
  agentId: string;
  db: EngineConnection;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

export type OpenClawAgentDatabaseOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
};

/** Internal Doctor custody; never part of the plugin-facing database options. */
export type OpenClawAgentDatabaseRepairAdmission = {
  /** Doctor's requested SQLite coverage; ordinary runtime admission retains FULL. */
  integrityCheck?: "quick" | "full";
  /** Tables this repair callback mutates; pending schema migrations retain their own coverage. */
  integrityTables?: readonly string[];
  /** Bind repair admission to the physical database inspected and backed up by its owner. */
  expectedIdentity?: DatabaseFileIdentity;
  /** Live caller authority for native open and schema/registry admission mutations. */
  assertCurrent?: () => void;
};

/** Shared-state registry row describing an agent database seen by this process. */
export type OpenClawRegisteredAgentDatabase = {
  agentId: string;
  path: string;
  schemaVersion: number;
  lastSeenAt: number;
  sizeBytes: number | null;
};

export type OpenClawAgentDatabaseRegistryReadResult =
  | { status: "available"; entries: OpenClawRegisteredAgentDatabase[] }
  | { status: "unavailable" };

/** An in-process witness from the canonical invalidator, never serialized as authority. */
export type AgentDatabaseRegistryChange = Readonly<{ previous: symbol; current: symbol }>;

export type OpenClawAgentDatabaseRegistrationCommit = Readonly<{
  agentId: string;
  agentPath: string;
  stateDatabasePath: string;
  stateDatabaseIdentity: string;
}>;

export type AgentDatabaseRegistryWorkerOperations = {
  "agentDatabaseRegistry.remove": {
    input: { agentId: string; agentPath: string; identity: DatabasePathIdentity };
    output: OpenClawAgentDatabaseRegistrationCommit;
  };
};

export type OpenClawAgentDatabaseRegistrationObserver = {
  starting?: () => void;
  committed?: (receipt: OpenClawAgentDatabaseRegistrationCommit) => void;
};

export type OpenClawAgentDatabaseOwnerInspection =
  | { status: "owned"; agentId: string }
  | { status: "unowned" }
  | { status: "unreadable" };

export const SESSION_PARTICIPANTS_TABLE = "session_participants";
