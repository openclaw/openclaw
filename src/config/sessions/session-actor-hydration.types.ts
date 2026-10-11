import type { SessionTreeEntry } from "@openclaw/agent-core";
import type { Selectable } from "kysely";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { SessionActorHotState } from "./session-actor-state.types.js";
import type { ResolvedSessionEntryRow } from "./session-entry-storage.types.js";
import type { SessionPendingInputRow } from "./session-pending-input.types.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-projection-append.js";

export type SessionActorStoredState = {
  agentId: string;
  path: string;
  hot: SessionActorHotState;
  /** Lookup siblings were admitted in the same hydration statement. */
  entryRows: Map<string, ResolvedSessionEntryRow | undefined>;
  window: Selectable<DB["session_windows"]> | undefined;
  hasBoard: boolean;
  pendingInputs: Map<string, SessionPendingInputRow>;
  completions: Map<string, Selectable<DB["session_input_completions"]>>;
  transcript: {
    coldArchive:
      | Omit<Selectable<DB["session_transcript_cold_archives"]>, "archive_blob">
      | undefined;
    projection: (SessionTranscriptProjectionState & { hasUnclassifiedEvents: boolean }) | undefined;
    identities: Map<string, Selectable<DB["transcript_event_identities"]>>;
    active: Map<number, Selectable<DB["session_transcript_active_events"]>>;
    navigation: Array<SessionTreeEntry & { seq: number }>;
    /** Only payloads acquired by this residency are retained; older bodies remain bounded reads. */
    payloads: Map<number, unknown>;
  };
};
