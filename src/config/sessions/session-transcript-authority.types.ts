import type { SqliteCommitReceipt } from "../../infra/sqlite-commit-receipt.js";
import type { SessionTranscriptTerminalModel } from "../../sessions/transcript-terminal-model.js";
import type { SessionEntryPublicationSource } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SessionActorTranscriptRow } from "./session-actor-bounded-history.js";
import type { SessionActorHotState } from "./session-actor-state.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";

/** Committed context facts, optionally carrying a resident actor's exact metadata rewrite. */
export type SessionTranscriptAuthority = SessionTranscriptContextVersion & {
  sessionId: string;
  sessionKey: string;
  leafEventId: string | null;
  indexedSeq: number | null;
  activeMessageCount: number | null;
  needsRebuild: number | null;
  /** Absent needs a tail lookup; null is a known empty bounded preview. */
  lastMessagePreview?: string | null;
  terminalModel?: SessionTranscriptTerminalModel | null;
  actorRewrite?: {
    before: SessionTranscriptContextVersion;
    postimage: SessionActorHotState;
    rows: SessionActorTranscriptRow[];
  };
};
export type SessionTranscriptAuthorityReceipt = SqliteCommitReceipt<
  SessionTranscriptAuthority,
  SessionEntryPublicationSource
>;
