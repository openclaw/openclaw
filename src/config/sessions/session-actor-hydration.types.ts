import type { Selectable } from "kysely";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { SessionActorHotState } from "./session-actor-state.types.js";
import type { ResolvedSessionEntryRow } from "./session-entry-storage.types.js";
import type { SessionEntryWindowRow } from "./session-entry-window.types.js";
import type { SessionPendingInputRow } from "./session-pending-input.types.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-projection-append.js";
import type { SessionTranscriptContextMetadata } from "./session-transcript-projection-facts.types.js";

export type SessionActorStoredState = {
  agentId: string;
  path: string;
  hot: SessionActorHotState;
  /** Lookup siblings were admitted in the same hydration statement. */
  entryRows: Map<string, ResolvedSessionEntryRow | undefined>;
  window: SessionEntryWindowRow | undefined;
  hasBoard: boolean;
  pendingInputs: Map<string, SessionPendingInputRow>;
  completions: Map<string, Selectable<DB["session_input_completions"]>>;
  transcript: {
    /** Only a complete window can prove that an identity or history row is absent. */
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
  };
};
