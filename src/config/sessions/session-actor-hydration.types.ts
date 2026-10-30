import type { Selectable } from "kysely";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { SessionActorHotState } from "./session-actor-state.types.js";
import type {
  ResolvedSessionEntryRow,
  SessionEntrySnapshotRow,
} from "./session-entry-storage.types.js";
import type { SessionEntryWindowRow } from "./session-entry-window.types.js";
import type { SessionPendingInputRow } from "./session-pending-input.types.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-projection-append.js";
import type {
  SessionTranscriptContextMetadata,
  SessionTranscriptContextStats,
} from "./session-transcript-projection-facts.types.js";

export const MAX_SESSION_ACTOR_COMPLETIONS = 512;

export type SessionActorStoredState = {
  agentId: string;
  path: string;
  hot: SessionActorHotState;
  /** Lookup siblings were admitted in the same hydration statement. */
  entryRows: Map<
    string,
    | {
        entry: ResolvedSessionEntryRow["entry"];
        row: Omit<ResolvedSessionEntryRow["row"], keyof SessionEntrySnapshotRow> & {
          [K in keyof SessionEntrySnapshotRow]?: never;
        };
      }
    | undefined
  >;
  window: SessionEntryWindowRow | undefined;
  hasBoard: boolean;
  pendingInputs: Map<string, SessionPendingInputRow>;
  completions: Map<string, Selectable<DB["session_input_completions"]>>;
  /** Only a complete cache can prove that a durable completion is absent. */
  completionsComplete: boolean;
  transcript: {
    /** Complete means every identity row for the session, not just the bounded window. */
    complete: boolean;
    coldArchive:
      | Omit<Selectable<DB["session_transcript_cold_archives"]>, "archive_blob">
      | undefined;
    projection: (SessionTranscriptProjectionState & { hasUnclassifiedEvents: boolean }) | undefined;
    identities: Map<string, Selectable<DB["transcript_event_identities"]>>;
    active: Map<number, Selectable<DB["session_transcript_active_events"]>>;
    navigation: Array<Record<string, unknown> & { seq: number }>;
    /** Current transaction's append bodies; committed receipts own them after settlement. */
    payloads: Map<number, { event: unknown; serializedBytes: number }>;
    contextMetadata?: SessionTranscriptContextMetadata;
    contextStats?: SessionTranscriptContextStats;
  };
};
