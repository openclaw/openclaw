import type { SessionEntrySnapshot } from "../../../packages/memory-host-sdk/src/host/session-files.js";
import type { SessionResetRecallCutoff } from "../../../packages/memory-host-sdk/src/host/session-reset-recall.js";
import type {
  SessionTranscriptCorpusEntry,
  SessionTranscriptCorpusOptions,
  SessionTranscriptCorpusScope,
} from "../../../packages/memory-host-sdk/src/host/session-transcript-corpus.types.js";
import type { PreparedSessionHistoryReadTarget } from "../../gateway/session-history-read.types.js";
import type {
  SessionTranscriptProjectionSelection,
  SessionTranscriptProjectionSelectionResults,
} from "../../gateway/session-transcript-read.types.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
import type {
  LatestTranscriptAssistantText,
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptVisibleMessageDeltaLimits,
  SessionTranscriptVisibleMessageDeltaResult,
} from "./session-accessor.sqlite-contract.js";
import type {
  SessionTranscriptBoundedMessageTailOptions,
  SessionTranscriptBoundedMessageTailPage,
  SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-projection-read.js";
import type { SessionTranscriptStats, TranscriptEvent } from "./session-accessor.types.js";
import type { HarnessCompletionSourceSnapshot } from "./session-harness-completion-source.types.js";
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
  SessionConversationBinding,
  SessionHistorySubagentFacts,
  SessionHistorySubagentLookup,
} from "./session-history-types.js";
import type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "./session-memory-targets.types.js";
import type {
  PendingInputHistoryQuery,
  PendingInputHistorySnapshot,
} from "./session-pending-input-history.types.js";
import type {
  SessionTranscriptAccountingOptions,
  SessionTranscriptAccountingSnapshot,
} from "./session-transcript-accounting.types.js";
import type { SessionTranscriptAnchorSelection } from "./session-transcript-anchor-read.kernel.js";
import type { SessionTranscriptAnchorFacts } from "./session-transcript-anchor-read.types.js";
import type {
  SessionTranscriptCurrentTurnEntryRead,
  SessionTranscriptCurrentTurnEntryRequest,
  SessionTranscriptMaintenanceFacts,
  SessionTranscriptMaintenanceRead,
} from "./session-transcript-hydration.types.js";
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
  allowMissing?: true;
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
  "harness-completion-source": {
    input: { claim: HarnessCompletionRecovery };
    output: HarnessCompletionSourceSnapshot;
  };
  "completion-source.open": {
    input: { sourceId: string; claim: HarnessCompletionRecovery };
    output: void;
  };
  "completion-source.release": {
    input: { sourceId: string };
    output: void;
  };
  "raw-delta": {
    input: { limits: SessionTranscriptRawDeltaLimits };
    output: SessionTranscriptRawDeltaResult;
  };
  "visible-delta": {
    input: { limits: SessionTranscriptVisibleMessageDeltaLimits };
    output: SessionTranscriptVisibleMessageDeltaResult;
  };
  "latest-assistant": {
    input: Record<never, never>;
    output: LatestTranscriptAssistantText | undefined;
  };
  "conversation-binding": {
    input: { conversationRef: string };
    output: SessionConversationBinding | null;
  };
  visibility: {
    input: Pick<PreparedSessionHistoryReadTarget, "stateDatabase" | "sourceDiscovery"> & {
      lookups: SessionHistorySubagentLookup[];
      incognitoSources: Array<[string, boolean]>;
    };
    output: { facts: SessionHistorySubagentFacts; missingSources: string[] };
  };
  anchors: { input: SessionTranscriptAnchorSelection; output: SessionTranscriptAnchorFacts };
  accounting: {
    input: { options: SessionTranscriptAccountingOptions };
    output: SessionTranscriptAccountingSnapshot;
  };
  "bounded-tail": {
    input: { options: SessionTranscriptBoundedMessageTailOptions };
    output: SessionTranscriptBoundedMessageTailPage;
  };
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
    input: Pick<
      SessionTranscriptSearchParams,
      "query" | "limit" | "match" | "role" | "order" | "sessionId"
    > & {
      sessions: IncognitoHistoryTarget[];
    };
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
  "current-turn-entry": {
    input: SessionTranscriptCurrentTurnEntryRequest;
    output: SessionTranscriptCurrentTurnEntryRead;
  };
  maintenance: {
    input: { request: SessionTranscriptMaintenanceRead };
    output: SessionTranscriptMaintenanceFacts;
  };
  "recent-active-events": {
    input: { maxEvents: number };
    output: TranscriptEvent[];
  };
  "latest-active-message": {
    input: Record<never, never>;
    output: SessionTranscriptMessageEvent | undefined;
  };
  "pending-inputs": {
    input: { query: Omit<PendingInputHistoryQuery, "sessionKey" | "sessionId"> };
    output: PendingInputHistorySnapshot;
  };
  stats: { input: Record<never, never>; output: SessionTranscriptStats };
  "message-presence": { input: Record<never, never>; output: boolean };
  "visitor-source": {
    input: { offset?: number };
    output: {
      messages: Array<{ message: unknown; seq: number }>;
      nextOffset?: number;
    };
  };
  "memory-entry": {
    input: { includeMessages?: boolean; readSessionId?: string };
    output: SessionEntrySnapshot;
  };
  "memory-corpus": {
    input: {
      scope: SessionTranscriptCorpusScope;
      options: SessionTranscriptCorpusOptions;
      sessionKeys: string[];
    };
    output: SessionTranscriptCorpusEntry[];
  };
  "memory-reset-recall": { input: { readSessionId?: string }; output: SessionResetRecallCutoff };
  "native-context": {
    input: Record<never, never>;
    output: IncognitoContextReadResult<SessionTranscriptContextSnapshot>;
  };
  "native-context-current": {
    input: Pick<SessionTranscriptContextSnapshot, "version"> & { through?: TranscriptEntryAnchor };
    output: IncognitoContextReadResult<void>;
  };
};

export type IncognitoHistoryOperations = {
  [Key in Exclude<keyof Reads, "search"> as `session.history.${Key}`]: {
    input: IncognitoHistoryTarget & Reads[Key]["input"];
    output: Reads[Key]["output"];
  };
} & {
  "session.history.search": Reads["search"];
  "session.history.memory-targets": {
    input: { selectors: MemorySessionSelectors; sessions: IncognitoHistoryTarget[] };
    output: MemorySessionTarget[];
  };
};

export function isIncognitoHistoryCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<IncognitoHistoryOperations> {
  return command.type.startsWith("session.history.");
}

export function incognitoHistoryKeys(
  command: SqliteWorkerCommand<IncognitoHistoryOperations>,
): string[] {
  if (
    command.type === "session.history.search" ||
    command.type === "session.history.memory-targets"
  ) {
    const keys = command.input.sessions.map((session) => session.sessionKey);
    if (new Set(keys).size !== keys.length) {
      throw new Error("Incognito search must retain unique selected sessions");
    }
    return keys;
  }
  if (command.type !== "session.history.memory-corpus") {
    return [command.input.sessionKey];
  }
  const keys = command.input.sessionKeys;
  if (!keys.includes(command.input.sessionKey) || new Set(keys).size !== keys.length) {
    throw new Error("Incognito Memory corpus must retain its selected sessions");
  }
  return keys;
}
