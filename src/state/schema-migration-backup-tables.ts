import { MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";

/** Destination versions, declared only with proof through the complete migration runner. */
export const SCHEMA_MIGRATION_BACKUP_TABLES: Record<
  "agent" | "state",
  Readonly<Partial<Record<number, readonly string[]>>>
> = {
  agent: {},
  state: {
    [MEETING_TRANSCRIPT_START_TIME_SCHEMA_VERSION]: ["meeting_transcript_sessions"],
  },
};
