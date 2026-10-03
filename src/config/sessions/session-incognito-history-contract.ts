import type { SessionEntrySnapshot } from "../../../packages/memory-host-sdk/src/host/session-files.js";
import type { SessionResetRecallCutoff } from "../../../packages/memory-host-sdk/src/host/session-reset-recall.js";
import type {
  SessionTranscriptProjectionSelection,
  SessionTranscriptProjectionSelectionResults,
} from "../../gateway/session-transcript-read.types.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { SessionTranscriptStats, TranscriptEvent } from "./session-accessor.types.js";
import type {
  PreparedSessionTranscriptHydration,
  SessionBranchSummaryReadResult,
  SessionModelContextLimits,
  SessionPendingInputReceipt,
  SessionPreviewItem,
  SessionTitleFields,
  SessionTranscriptEventMatch,
  SessionTranscriptContextSnapshot,
  SessionTranscriptModelContext,
  SessionTranscriptWatermark,
} from "./session-history-read.types.js";
import type {
  SessionTranscriptSearchParams,
  SessionTranscriptSearchResult,
} from "./session-transcript-search.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

/** The actor supplies all physical storage and agent identity; callers select one current session. */
export type IncognitoHistoryTarget = {
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

export type IncognitoContextReadResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; message: string };

type Reads = {
  [Key in keyof SessionTranscriptProjectionSelectionResults]: {
    input: Omit<Extract<SessionTranscriptProjectionSelection, { kind: Key }>, "kind">;
    output: SessionTranscriptProjectionSelectionResults[Key];
  };
} & {
  title: {
    input: { includeInterSession?: boolean };
    output: { kind: "session-title-fields"; fields: SessionTitleFields };
  };
  preview: {
    input: { maxItems: number; maxChars: number };
    output: { kind: "session-preview"; items: SessionPreviewItem[] };
  };
  branches: { input: Record<never, never>; output: SessionBranchSummaryReadResult };
  context: {
    input: { through?: TranscriptEntryAnchor; limits?: SessionModelContextLimits };
    output: SessionTranscriptModelContext;
  };
  match: {
    input: { match: SessionTranscriptEventMatch };
    output: { kind: "transcript-match"; result: { event: TranscriptEvent } | undefined };
  };
  search: {
    input: Pick<SessionTranscriptSearchParams, "query" | "limit" | "match" | "role" | "order">;
    output: { kind: "transcript-search"; result: SessionTranscriptSearchResult };
  };
  watermark: {
    input: Record<never, never>;
    output: { kind: "transcript-watermark"; watermark: SessionTranscriptWatermark };
  };
  receipts: {
    input: { runIds: readonly string[] };
    output: { kind: "session-pending-input-receipts"; receipts: SessionPendingInputReceipt[] };
  };
  hydrate: {
    input: { limits?: { maxBytes: number; maxEvents: number }; maxEventBytes?: number };
    output: PreparedSessionTranscriptHydration;
  };
  stats: { input: Record<never, never>; output: SessionTranscriptStats };
  "memory-entry": { input: Record<never, never>; output: SessionEntrySnapshot };
  "memory-reset-recall": { input: Record<never, never>; output: SessionResetRecallCutoff };
  "native-context": {
    input: Record<never, never>;
    output: IncognitoContextReadResult<SessionTranscriptContextSnapshot>;
  };
  "native-context-current": {
    input: Pick<SessionTranscriptContextSnapshot, "version">;
    output: IncognitoContextReadResult<void>;
  };
};

export type IncognitoHistoryOperations = {
  [Key in keyof Reads as `session.history.${Key}`]: {
    input: IncognitoHistoryTarget & Reads[Key]["input"];
    output: Reads[Key]["output"];
  };
};

export function isIncognitoHistoryCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<IncognitoHistoryOperations> {
  return command.type.startsWith("session.history.");
}
