import type { DatabaseSync } from "node:sqlite";
import type { SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import type {
  DatabaseFileIdentity,
  DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";

export const OPENCLAW_AGENT_SCHEMA_VERSION = 24;
export const AGENT_STORAGE_SCHEMA_VERSION = 23;
export const TRANSCRIPT_FTS_ROW_SCHEMA_VERSION = 22;
export const AGENT_MEDIA_SCHEMA_VERSION = 17;
export const CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION = 21;
// Bound the disk work shared by startup inspection, admission, and canonical preparation.
export { AGENT_DATABASE_PREFLIGHT_CONCURRENCY } from "../infra/worker-pool-sizing.js";
// Bounds startup session reconciliation for large fleets without letting one slow store hold every slot.
export const AGENT_DATABASE_PREPARATION_CONCURRENCY = 4;

export type OpenClawAgentDatabase = {
  agentId: string;
  db: DatabaseSync;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

export type OpenClawAgentDatabaseOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
};

/** Internal Doctor custody; never part of the plugin-facing database options. */
export type OpenClawAgentDatabaseRepairAdmission = {
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
