import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import type { SqliteTranscriptSnapshotRow } from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type { TranscriptEvent, SessionTranscriptWriteScope } from "./session-accessor.types.js";
import type { SessionEntryPatchCommitted } from "./session-entry-patch.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { SessionEntry } from "./types.js";

export type SessionMessageRewriteSelection = {
  scope: ResolvedTranscriptScope;
  target:
    | { kind: "anchor"; anchor: TranscriptEntryAnchor; active?: "exact" | "sequence" }
    | { kind: "terminal-assistant"; runId: string };
  expectedEntry?: {
    lifecycleRevision: string | null;
    activeWriterRunId?: string | null;
    owner?: SessionTranscriptWriteScope["expectedOwner"];
  };
};
export type SessionMessageRewriteSnapshot = {
  seq: number;
  eventJson: string;
  event: Record<string, unknown>;
};
export type SessionMessageRewriteCommitted = {
  kind: "session-message-rewrite";
  result: { generation: string; messageId: string; message: unknown } | null;
};

export type SessionTranscriptEventCommitted = {
  kind: "session-transcript-event";
  appended: boolean;
  projectionNeedsReconcile: boolean;
};

export type SessionTranscriptCorrectionCommitted = {
  kind: "session-transcript-correction";
  generation: string | null;
};

export type ManualTranscriptCompactPreparation = {
  rows: SqliteTranscriptSnapshotRow[];
  sessionSnapshot: SqliteLifecycleTargetSnapshot;
};

export type SessionTranscriptCorrectionInput = {
  scope: ResolvedTranscriptScope;
  fence: SessionTranscriptWriteScope;
  version: SessionTranscriptContextVersion;
  allowLaterAppends: boolean;
  rows: Array<{ entryId: string; expectedEventJson: string; event: TranscriptEvent }>;
};

export type ManualTranscriptCompactCommit = {
  previous: Map<string, SessionEntry>;
  current: Map<string, SessionEntry>;
};

export type RefusedTranscriptOwnerSource = {
  refusedOwnerSource: NonNullable<SessionEntryPatchCommitted["refusedSource"]>;
};
