import type { Selectable, SqlBool } from "kysely";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { SessionEntryWindowRow } from "./session-entry-window.types.js";
import type { SessionTranscriptWatermark } from "./session-transcript-context-version.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionEntryRow = Selectable<DB["session_nodes"]>;

export type SqliteSessionOwnerRow = {
  owner_actor_type?: string | null;
  owner_actor_id?: string | null;
  owner_assigned_by_type?: string | null;
  owner_assigned_by_id?: string | null;
  owner_assigned_at?: number | null;
};

export type SessionEntrySnapshotRow = {
  session_diff_baseline_json?: string | null;
  skills_snapshot_json?: string | null;
  system_prompt_report_json?: string | null;
};

export type ResolvedSessionEntryRow = {
  entry: SessionEntry;
  row: Pick<SessionEntryRow, "current_session_id" | "entry_json" | "session_key" | "updated_at"> &
    SqliteSessionOwnerRow &
    SessionEntrySnapshotRow &
    Partial<Pick<SessionEntryRow, "legacy_acp_migration_json">> & {
      board_present?: SqlBool;
      member_ids_json?: string;
      row_transcript_window_id?: string | null;
      row_transcript_json?: string | null;
      row_transcript_updated_at?: number | null;
      row_transcript_source_updated_at?: number | null;
      row_transcript_indexed_seq?: number | null;
      window?: SessionEntryWindowRow | null;
      transcriptWatermark?: SessionTranscriptWatermark & { sessionId: string };
    };
};
