import { MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";

/** Destination versions, declared only with proof through the complete migration runner. */
export const SCHEMA_MIGRATION_BACKUP_TABLES: Record<
  "agent" | "state",
  Readonly<Partial<Record<number, readonly string[]>>>
> = {
  agent: {
    27: ["context_engine_turn_outbox", "sqlite_stat1", "sqlite_stat4"],
    28: [
      "transcript_event_identities",
      "session_windows",
      "memory_entry_origins",
      "sqlite_stat1",
      "sqlite_stat4",
    ],
  },
  state: {
    [MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION]: ["meeting_transcript_sessions"],
    26: ["session_state_heads", "sqlite_stat1", "sqlite_stat4"],
  },
};
