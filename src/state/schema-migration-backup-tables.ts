import { CLIENT_CREDENTIAL_SOURCE_TABLES } from "../infra/client-credential-schema.js";
import { AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION,
  MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";

/** Destination versions, declared only with proof through the complete migration runner. */
export const SCHEMA_MIGRATION_BACKUP_TABLES: Record<
  "agent" | "state",
  Readonly<Partial<Record<number, readonly string[]>>>
> = {
  agent: {
    [AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION]: [
      "trajectory_runtime_events",
      "sqlite_stat1",
      "sqlite_stat4",
    ],
    27: ["context_engine_turn_outbox", "sqlite_stat1", "sqlite_stat4"],
    28: [
      "transcript_event_identities",
      "session_windows",
      "memory_entry_origins",
      "sqlite_stat1",
      "sqlite_stat4",
    ],
    29: ["session_nodes", "session_reactions", "sqlite_stat1", "sqlite_stat4"],
    31: ["memory_index_sources", "memory_index_chunks"],
    // PostgreSQL-only function replacement; SQLite advances metadata only.
    32: [],
    // PostgreSQL-only derived vector projection; SQLite advances metadata only.
    33: [],
    // PostgreSQL-only index ordering; SQLite advances metadata only.
    34: [],
    // PostgreSQL-only partial-index ordering; SQLite advances metadata only.
    35: [],
    // PostgreSQL-only exact-path index; SQLite advances metadata only.
    36: [],
  },
  state: {
    [CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION]: [
      ...CLIENT_CREDENTIAL_SOURCE_TABLES,
      "sqlite_stat1",
      "sqlite_stat4",
    ],
    [MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION]: ["meeting_transcript_sessions"],
    26: ["session_state_heads", "sqlite_stat1", "sqlite_stat4"],
    27: ["acp_replay_events", "skill_usage", "state_leases", "sqlite_stat1", "sqlite_stat4"],
    28: [
      "github_publication_requests",
      "github_personal_publication_requests",
      "github_repository_publication_requests",
    ],
    // Only shared-state version and content metadata change.
    30: [],
    31: [
      "local_workspace_projections",
      "local_workspace_manifest_nodes",
      "sqlite_stat1",
      "sqlite_stat4",
    ],
    // PostgreSQL-only index ordering; SQLite advances metadata only.
    32: [],
    // PostgreSQL-only partial-index ordering; SQLite advances metadata only.
    33: [],
  },
};
