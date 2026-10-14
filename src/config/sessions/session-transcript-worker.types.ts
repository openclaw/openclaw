import type { Result } from "@openclaw/normalization-core/result";
import type { ProgressCard } from "../../../packages/gateway-protocol/src/index.js";
import type {
  SessionFileEntry,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import type { BoardReadOperations } from "../../boards/sqlite-board-operations.js";
import type { PreparedSessionHistoryReadTarget } from "../../gateway/session-history-read.types.js";
import type { SessionPreviewItem, SessionTitleFields } from "../../gateway/session-utils.types.js";
import type { SessionMemoryTranscript } from "../../hooks/bundled/session-memory/capture.types.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawAgentDatabaseReadValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import type { VoiceSessionMatch } from "../../talk/client-voice-session-store.js";
import type {
  TrajectoryRetentionWorkerInput,
  TrajectoryRuntimeRetentionPlan,
} from "../../trajectory/runtime-retention.contract.js";
import type { SqliteTrajectoryRuntimeReadScope } from "../../trajectory/runtime-store.contract.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import type {
  SessionActivitySummaryBatchInput,
  SessionActivitySummaryBatchResult,
} from "./activity-summary-source.types.js";
import type {
  SessionCleanupReadInput,
  SessionCleanupReadResult,
} from "./cleanup-service-read.types.js";
import type {
  CombinedSessionStoreTopologyRequest,
  CombinedSessionStoreTopologyResult,
} from "./combined-store.types.js";
import type { ConversationDeliveryRecord } from "./conversation-delivery-store.types.js";
import type {
  ConversationRowsWorkerInput,
  ConversationRecord,
} from "./conversation-registry.types.js";
import type { ArchivedSessionEvictionBatch } from "./disk-budget.types.js";
import type { SessionGoalOperationLookupResult } from "./goals-operations.types.js";
import type {
  SessionPendingArchivesWorkerInput,
  SessionArchivePruningWorkerInput,
} from "./session-accessor.sqlite-archive-types.js";
import type {
  SessionBranchSummaryReadRequest,
  SessionBranchSummaryReadResult,
} from "./session-accessor.sqlite-branches.js";
import type {
  LatestTranscriptAssistantText,
  TranscriptEvent,
  SessionTranscriptStats,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptVisibleMessageDeltaResult,
} from "./session-accessor.sqlite-contract.js";
import type {
  SessionIdentityEvidenceIdentity,
  SessionIdentityEvidenceResult,
} from "./session-accessor.sqlite-entry-availability.js";
import type {
  LifecycleArtifactCleanupRequest,
  LifecycleArtifactCleanupWorkerResult,
  SessionMaintenanceReadCommand,
  SessionMaintenanceReadResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { listSessionPendingInputReceipts } from "./session-accessor.sqlite-pending-input-receipts.js";
import type { SessionTranscriptWatermark } from "./session-accessor.sqlite-transcript-watermark-read.js";
import type {
  SessionEntryReadScope,
  SessionTranscriptReadScope,
} from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type {
  SessionEntryListWorkerInput,
  SessionEntryListWorkerResult,
  SessionEntryReadWorkerInput,
  SessionEntryReadWorkerResult,
  SessionExactEntriesWorkerInput,
  SessionExactEntriesWorkerRequest,
  SessionExactEntriesWorkerResult,
  SessionRuntimeTargetWorkerInput,
  SessionRuntimeTargetWorkerResult,
} from "./session-entry-read.types.js";
import type * as HarnessCompletionSourceWorker from "./session-harness-completion-source.types.js";
import type { PublishedSessionTranscriptArchive } from "./session-history-archive-pruning.types.js";
import type { SessionContextMessagesWorkerInput } from "./session-history-read.types.js";
import type {
  ChatHistoryDisplayRequest,
  ChatHistoryDisplayResult,
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
  SessionHistoryDelta,
} from "./session-history-types.js";
import type { SessionMembershipFacts } from "./session-membership-facts.types.js";
import type {
  PendingInputHistoryWorkerInput,
  PendingInputHistorySnapshot,
} from "./session-pending-input-history.types.js";
import type * as PendingInputSourceWorker from "./session-pending-input-source.types.js";
import type {
  SessionRetirementReadResult,
  SessionRetirementReadWorkerInput,
} from "./session-retirement-read.types.js";
import type {
  SessionRowFactsWorkerInput,
  SessionRowFactsWorkerResult,
  SessionRowPresenceWorkerInput,
} from "./session-row-facts.types.js";
import type {
  SessionMembersWorkerInput,
  SessionMembershipFactsWorkerInput,
  SessionSuggestionsWorkerInput,
  SessionReactionsWorkerInput,
  SessionReactionsWorkerResult,
} from "./session-sharing-read.types.js";
import type { SessionMembersSnapshot } from "./session-sharing-store.kernel.js";
import type { StoredSessionSuggestion } from "./session-sharing-store.types.js";
import type { ResolvedSqliteStoreTarget } from "./session-sqlite-target.js";
import type {
  SessionStoreProjectionWorkerInput,
  SessionStoreProjectionWorkerResult,
} from "./session-store-projection.types.js";
import type {
  SessionStoreTargetInventoryRequest,
  SessionStoreTargetInventoryResult,
  SessionStoreTargetReadRequest,
  SessionStoreTargetReadResult,
} from "./session-store-target-inventory.js";
import type { SessionTranscriptAnchorFacts } from "./session-transcript-anchor-read.types.js";
import type {
  SessionTranscriptHydrationWorkerInput,
  SessionTranscriptCurrentTurnEntryWorkerInput,
  SessionTranscriptRecentActiveEventsWorkerInput,
  SessionTranscriptLatestActiveMessageWorkerInput,
  SessionTranscriptMaintenanceWorkerInput,
  SessionTranscriptHydrationReaders,
  SessionTranscriptHydrationWorkerValues,
} from "./session-transcript-hydration.types.js";
import type {
  SessionColdMetadataWorkerInput,
  SessionColdMetadataWorkerResult,
  SessionColdStorageInventoryWorkerInput,
  SessionTranscriptInventoryWorkerInput,
  SessionTranscriptInventoryWorkerValues,
  SessionTranscriptInventoryReaders,
} from "./session-transcript-inventory.types.js";
import type { SessionTranscriptProjectionReceipt } from "./session-transcript-projection-facts.types.js";
import type { SessionTranscriptSearchResult } from "./session-transcript-search.types.js";
import type { SessionTranscriptWorkerReadError } from "./session-transcript-worker-error.types.js";
import type {
  SessionSqliteTargetWorkerInput,
  SessionResetRecallWorkerInput,
  SessionEntryWorkerInput,
  SessionEntriesWorkerInput,
  SessionEntriesWorkerResult,
  SessionEntryCurrentWorkerInput,
  SessionEntryCurrentWorkerResult,
  BoardSnapshotWorkerInput,
  BoardWidgetDocumentWorkerInput,
  SessionHistoricalEvictionCandidatesWorkerInput,
  SessionArchivedEvictionCandidatesWorkerInput,
  SessionTranscriptMatchWorkerInput,
  SessionTranscriptSearchWorkerInput,
  SessionProjectionStatusWorkerInput,
  SessionTranscriptAnchorsWorkerInput,
  SessionModelContextWorkerInput,
  SessionTranscriptWatermarkWorkerInput,
  SessionTranscriptStatsWorkerInput,
  SessionTranscriptMessagePresenceWorkerInput,
  SessionTranscriptDeltaWorkerInput,
  SessionTranscriptLatestAssistantWorkerInput,
  SessionMemoryCaptureWorkerInput,
  SessionProgressCardWorkerInput,
  VoiceSessionsWorkerInput,
} from "./session-transcript-worker-read.types.js";
import type {
  ConversationDeliveryWorkerInput,
  SessionGoalOperationReceiptWorkerInput,
  SessionPendingInputReceiptsWorkerInput,
} from "./session-transcript-worker-receipts.types.js";

export type {
  PreparedSessionTranscriptHydration,
  SessionTranscriptCurrentTurnEntryRead,
  SessionTranscriptCurrentTurnEntryRequest,
  SessionTranscriptHydrationChunk,
  SessionTranscriptHydrationWorkerResult,
} from "./session-transcript-hydration.types.js";

export type SessionTranscriptHistoryWorkerInput = {
  kind: "history-page";
  database: { agentId: string; path: string };
  request: SessionHistoryWorkerRequest;
  target: Omit<PreparedSessionHistoryReadTarget, "database">;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

export type SessionPreviewWorkerInput = {
  kind: "session-preview";
  database: { agentId: string; path: string };
  target: {
    agentId: string;
    sessionId: string;
    sessionKey?: string;
    entryValidationKey?: string;
  };
  env?: NodeJS.ProcessEnv;
  maxItems: number;
  maxChars: number;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

type SessionTitleFieldsWorkerInput = {
  kind: "session-title-fields";
  database: { agentId: string; path: string };
  scope: SessionTranscriptReadScope;
  includeInterSession?: boolean;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

type SessionActivitySummarySourceWorkerInput = SessionActivitySummaryBatchInput & {
  kind: "session-activity-summary-source";
  database: { agentId: string; path: string };
  admission?: UserTurnTranscriptAdmissionReceipt;
};

export type SessionDiagnosticTextWorkerInput = {
  kind: "session-diagnostic-text";
  database: { agentId: string; path: string };
  scope: SessionEntryReadScope & { agentId: string; databaseAgentId: string; sessionId: string };
  continuation?: CanonicalSessionReaderContinuation;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

type SessionStoreSummaryWorkerInput = {
  kind: "session-store-summary";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  agentIds: readonly string[];
  recentLimit: number;
  continuation?: CanonicalSessionReaderContinuation;
};

export const MAX_SESSION_ROW_FACTS_KEYS = 64;

export type {
  SessionRowFactsWorkerInput,
  SessionRowFactsWorkerResult,
  SessionRowPresenceWorkerInput,
} from "./session-row-facts.types.js";

type SessionMaintenanceReadWorkerInput = {
  kind: "session-maintenance-read";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  plan: SessionMaintenanceReadCommand;
};

type SessionStoreTargetWorkerInput = {
  kind: "session-store-target";
  request: SessionStoreTargetReadRequest;
};

type SessionTargetInventoryWorkerInput = {
  kind: "session-target-inventory";
  request: SessionStoreTargetInventoryRequest;
};

type CombinedSessionStoreTopologyWorkerInput = {
  kind: "combined-store-topology";
  request: CombinedSessionStoreTopologyRequest;
};

type SessionIdentityEvidenceWorkerInput = {
  kind: "session-identity-evidence";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  identities: readonly SessionIdentityEvidenceIdentity[];
  continuation?: CanonicalSessionReaderContinuation;
};

type SessionBranchSummaryWorkerInput = {
  kind: "branch-summaries";
  database: SessionBranchSummaryReadRequest["database"];
  request: Omit<SessionBranchSummaryReadRequest, "database">;
};

type TrajectoryEventsWorkerInput = {
  kind: "trajectory-events";
  database: { agentId: string; path: string };
  scope: SqliteTrajectoryRuntimeReadScope;
};

export type SessionHistoryWorkerInput =
  | SessionRetirementReadWorkerInput
  | TrajectoryRetentionWorkerInput
  | TrajectoryEventsWorkerInput
  | SessionCleanupReadInput
  | BoardSnapshotWorkerInput
  | BoardWidgetDocumentWorkerInput
  | SessionStoreProjectionWorkerInput
  | SessionBranchSummaryWorkerInput
  | { kind: "cli-process-history"; request: ChatHistoryDisplayRequest }
  | LifecycleArtifactCleanupRequest
  | { kind: "prewarm"; database: { agentId: string; path: string }; env: NodeJS.ProcessEnv }
  | SessionHistoricalEvictionCandidatesWorkerInput
  | SessionArchivedEvictionCandidatesWorkerInput
  | SessionArchivePruningWorkerInput
  | SessionPendingArchivesWorkerInput
  | SessionTranscriptInventoryWorkerInput
  | SessionColdMetadataWorkerInput
  | SessionColdStorageInventoryWorkerInput
  | SessionTranscriptHydrationWorkerInput
  | SessionTranscriptMaintenanceWorkerInput
  | SessionTranscriptCurrentTurnEntryWorkerInput
  | SessionTranscriptRecentActiveEventsWorkerInput
  | SessionTranscriptLatestActiveMessageWorkerInput
  | SessionTranscriptHistoryWorkerInput
  | SessionPreviewWorkerInput
  | SessionTitleFieldsWorkerInput
  | SessionTranscriptWatermarkWorkerInput
  | SessionTranscriptStatsWorkerInput
  | SessionTranscriptMessagePresenceWorkerInput
  | SessionTranscriptDeltaWorkerInput
  | SessionTranscriptLatestAssistantWorkerInput
  | SessionMemoryCaptureWorkerInput
  | SessionTranscriptAnchorsWorkerInput
  | SessionActivitySummarySourceWorkerInput
  | SessionRowPresenceWorkerInput
  | SessionProjectionStatusWorkerInput
  | SessionMembersWorkerInput
  | SessionSuggestionsWorkerInput
  | SessionReactionsWorkerInput
  | SessionMembershipFactsWorkerInput
  | SessionProgressCardWorkerInput
  | PendingInputHistoryWorkerInput
  | SessionPendingInputReceiptsWorkerInput
  | PendingInputSourceWorker.Input
  | HarnessCompletionSourceWorker.Input
  | SessionGoalOperationReceiptWorkerInput
  | ConversationRowsWorkerInput
  | ConversationDeliveryWorkerInput
  | SessionEntryListWorkerInput
  | SessionEntryReadWorkerInput
  | SessionRuntimeTargetWorkerInput
  | SessionEntryCurrentWorkerInput
  | SessionDiagnosticTextWorkerInput
  | SessionStoreSummaryWorkerInput
  | SessionExactEntriesWorkerInput
  | SessionRowFactsWorkerInput
  | SessionMaintenanceReadWorkerInput
  | SessionStoreTargetWorkerInput
  | SessionTargetInventoryWorkerInput
  | CombinedSessionStoreTopologyWorkerInput
  | SessionIdentityEvidenceWorkerInput
  | VoiceSessionsWorkerInput
  | SessionTranscriptSearchWorkerInput
  | SessionTranscriptMatchWorkerInput;

export type SessionTranscriptWorkerInput =
  | SessionSqliteTargetWorkerInput
  | SessionHistoryWorkerInput
  | SessionModelContextWorkerInput
  | SessionContextMessagesWorkerInput
  | SessionEntryWorkerInput
  | SessionEntriesWorkerInput
  | SessionResetRecallWorkerInput;

/** Only the dispatch owner attaches live physical proof; caller-prepared inputs cannot supply it. */
export type SessionTranscriptWorkerRequest = SessionTranscriptWorkerInput & {
  validation?: OpenClawAgentDatabaseReadValidation;
  projectionReceipt?: SessionTranscriptProjectionReceipt;
};

type SessionHistoryDatabaseWorkerInput = Extract<SessionHistoryWorkerInput, { database: unknown }>;

type PreparedHistoryInput<Input> = Input extends unknown ? Omit<Input, "database"> : never;
export type SessionHistoryWorkerPreparedInput =
  PreparedHistoryInput<SessionHistoryDatabaseWorkerInput>;

export type SessionTranscriptWorkerValues = SessionTranscriptInventoryWorkerValues &
  SessionTranscriptHydrationWorkerValues & {
    "session-retirement-read": {
      kind: "session-retirement-read";
      result: SessionRetirementReadResult;
    };
    "trajectory-events": { kind: "trajectory-events"; events: TrajectoryEvent[] };
    "trajectory-retention": {
      kind: "trajectory-retention";
      plan: TrajectoryRuntimeRetentionPlan;
    };
    "session-cleanup": SessionCleanupReadResult;
    "transcript-raw-delta": {
      kind: "transcript-raw-delta";
      result: SessionTranscriptRawDeltaResult;
    };
    "transcript-visible-delta": {
      kind: "transcript-visible-delta";
      result: SessionTranscriptVisibleMessageDeltaResult;
    };
    "transcript-latest-assistant": {
      kind: "transcript-latest-assistant";
      result: LatestTranscriptAssistantText | undefined;
    };
    "session-memory-capture": { kind: "session-memory-capture"; result: SessionMemoryTranscript };
    "board-snapshot": {
      kind: "board-snapshot";
      value: BoardReadOperations["boards.readSnapshot"]["output"];
    };
    "board-widget-document": {
      kind: "board-widget-document";
      value: BoardReadOperations["boards.readWidgetDocument"]["output"];
    };
    "session-maintenance-read": {
      kind: "session-maintenance-read";
      result: SessionMaintenanceReadResult;
      workerThreadId: number;
    };
    "cli-process-history": ChatHistoryDisplayResult;
    "conversation-rows": { kind: "conversation-rows"; rows: ConversationRecord[] };
    "conversation-delivery": { kind: "conversation-delivery"; record?: ConversationDeliveryRecord };
    prewarm: { kind: "prewarm" };
    "session-pending-archives": { kind: "session-pending-archives"; pending: boolean };
    "lifecycle-artifact-plan": LifecycleArtifactCleanupWorkerResult;
    "historical-eviction-candidates": { kind: "historical-eviction-candidates" } & (
      | { sessionIds: string[] }
      | { batch: ArchivedSessionEvictionBatch }
    );
    "session-archive-pruning": {
      kind: "session-archive-pruning";
      result: PublishedSessionTranscriptArchive[];
    };
    "transcript-search": { kind: "transcript-search"; result: SessionTranscriptSearchResult };
    "transcript-match": {
      kind: "transcript-match";
      result: { event: TranscriptEvent } | undefined;
    };
    "cold-metadata": SessionColdMetadataWorkerResult;
    "cold-storage-inventory": {
      kind: "cold-storage-inventory";
      hotTranscripts: number;
      coldTranscripts: number;
      embeddedArchiveBytes: number;
    };
    "sqlite-target": { target: ResolvedSqliteStoreTarget };
    "branch-summaries": { kind: "branch-summaries"; result: SessionBranchSummaryReadResult };
    "history-page": SessionHistoryWorkerResult;
    "session-preview": { kind: "session-preview"; items: SessionPreviewItem[] };
    "session-title-fields": { kind: "session-title-fields"; fields: SessionTitleFields };
    "transcript-watermark": { kind: "transcript-watermark"; watermark: SessionTranscriptWatermark };
    "transcript-stats": { kind: "transcript-stats"; stats: SessionTranscriptStats };
    "transcript-message-presence": { kind: "transcript-message-presence"; present: boolean };
    "transcript-anchors": { kind: "transcript-anchors"; facts: SessionTranscriptAnchorFacts };
    "session-activity-summary-source": {
      kind: "session-activity-summary-source";
      source: SessionActivitySummaryBatchResult;
    };
    "session-row-presence": boolean;
    "projection-status": boolean;
    "session-members": { kind: "session-members" } & SessionMembersSnapshot;
    "session-suggestions": { kind: "session-suggestions"; suggestions: StoredSessionSuggestion[] };
    "session-reactions": SessionReactionsWorkerResult;
    "session-membership-facts": SessionMembershipFacts;
    "session-progress-card": { kind: "session-progress-card"; card: ProgressCard | null };
    "goal-operation-receipt": {
      kind: "goal-operation-receipt";
      result: SessionGoalOperationLookupResult;
    };
    "session-pending-input-source": PendingInputSourceWorker.Value;
    "session-harness-completion-source": HarnessCompletionSourceWorker.Value;
    "session-pending-input-history": {
      kind: "session-pending-input-history";
      snapshot: PendingInputHistorySnapshot;
    };
    "session-pending-input-receipts": {
      kind: "session-pending-input-receipts";
      receipts: ReturnType<typeof listSessionPendingInputReceipts>;
    };
    "session-entry-list": SessionEntryListWorkerResult;
    "session-store-projection": SessionStoreProjectionWorkerResult;
    "session-store-summary": {
      kind: "session-store-summary";
      summary: ReturnType<
        typeof import("./session-accessor.sqlite-summary.js").readSessionStoreSummaryReadOnly
      >;
    };
    "session-entry-read": SessionEntryReadWorkerResult;
    "session-runtime-target": SessionRuntimeTargetWorkerResult;
    "session-entry-current": SessionEntryCurrentWorkerResult;
    "session-diagnostic-text": {
      kind: "session-diagnostic-text";
      text: string | undefined;
      source?: CapturedSessionEntryReadSource & { databaseIdentity: string };
    };
    "session-exact-entries": SessionExactEntriesWorkerResult;
    "session-row-facts": SessionRowFactsWorkerResult;
    "session-store-target":
      | SessionStoreTargetReadResult
      | {
          kind: "session-store-target";
          readError: import("./session-transcript-worker-error.types.js").SessionTranscriptWorkerReadError;
        };
    "session-target-inventory": SessionStoreTargetInventoryResult;
    "combined-store-topology": CombinedSessionStoreTopologyResult;
    "session-identity-evidence": {
      kind: "session-identity-evidence";
      evidence: SessionIdentityEvidenceResult[];
    };
    "voice-sessions": { kind: "voice-sessions"; matches: VoiceSessionMatch[] };
    "model-context": ReturnType<typeof readSessionTranscriptModelContext>;
    "context-messages": import("./session-history-read.types.js").SessionTranscriptContextSnapshot;
    "session-reset-recall": {
      cutoff: import("../../../packages/memory-host-sdk/src/host/session-reset-recall.js").SessionResetRecallCutoff;
    };
    "session-entry":
      | {
          entry: SessionFileEntry | null;
          resetRecallCutoff: ReturnType<typeof readSessionEntryResetRecallCutoff>;
        }
      | {
          snapshot: ReturnType<
            typeof import("./session-accessor.sqlite-read.js").readTranscriptExportSnapshotReadOnlySync
          >;
        };
    "session-entries": SessionEntriesWorkerResult;
  };

export type SessionTranscriptWorkerError =
  | SessionTranscriptWorkerReadError
  | { kind: "delta-visibility"; partial: SessionHistoryDelta };

export type SessionTranscriptWorkerSuccess<Value> = {
  ok: true;
  value: Value;
  closedHistoryDatabase?: SessionTranscriptHistoryWorkerInput["database"];
};

export type SessionTranscriptWorkerReply<Kind extends keyof SessionTranscriptWorkerValues> =
  | SessionTranscriptWorkerSuccess<SessionTranscriptWorkerValues[Kind]>
  | {
      ok: false;
      error: SessionTranscriptWorkerError;
    };

type SessionHistoryReader<
  Kind extends SessionHistoryWorkerInput["kind"],
  Field extends keyof SessionTranscriptWorkerValues[Kind] | undefined = undefined,
> = (
  input: PreparedHistoryInput<Omit<Extract<SessionHistoryWorkerInput, { kind: Kind }>, "kind">>,
) => Promise<
  Field extends keyof SessionTranscriptWorkerValues[Kind]
    ? SessionTranscriptWorkerValues[Kind][Field]
    : SessionTranscriptWorkerValues[Kind]
>;

type CancellableSessionHistoryReader<
  Kind extends SessionHistoryWorkerInput["kind"],
  Field extends keyof SessionTranscriptWorkerValues[Kind] | undefined = undefined,
> = (
  input: Parameters<SessionHistoryReader<Kind, Field>>[0],
  signal?: AbortSignal,
) => ReturnType<SessionHistoryReader<Kind, Field>>;

export type SessionHistoryWorkerDatabase = SessionTranscriptInventoryReaders &
  SessionTranscriptHydrationReaders & {
    readRetirement: CancellableSessionHistoryReader<"session-retirement-read", "result">;
    readTrajectoryEvents: CancellableSessionHistoryReader<"trajectory-events", "events">;
    readTrajectoryRetention: (
      input: Omit<TrajectoryRetentionWorkerInput, "kind" | "database">,
      options: { signal?: AbortSignal; timeoutMs: number },
    ) => Promise<TrajectoryRuntimeRetentionPlan>;
    readCleanup: SessionHistoryReader<"session-cleanup">;
    readRawDelta: CancellableSessionHistoryReader<"transcript-raw-delta", "result">;
    readVisibleDelta: CancellableSessionHistoryReader<"transcript-visible-delta", "result">;
    readLatestAssistant: CancellableSessionHistoryReader<"transcript-latest-assistant", "result">;
    readSessionMemoryCapture: CancellableSessionHistoryReader<"session-memory-capture", "result">;
    readBoardSnapshot: SessionHistoryReader<"board-snapshot", "value">;
    readBoardWidgetDocument: SessionHistoryReader<"board-widget-document", "value">;
    readBranchSummaries: CancellableSessionHistoryReader<"branch-summaries", "result">;
    readMessagePresence: CancellableSessionHistoryReader<"transcript-message-presence", "present">;
    readAnchors: CancellableSessionHistoryReader<"transcript-anchors", "facts">;
    readConversations: SessionHistoryReader<"conversation-rows", "rows">;
    prewarm: (input: { env: NodeJS.ProcessEnv }) => Promise<void>;
    readPendingArchives: CancellableSessionHistoryReader<"session-pending-archives", "pending">;
    readLifecycleArtifactPlan: CancellableSessionHistoryReader<"lifecycle-artifact-plan">;
    findTranscriptEvent: (
      request: SessionTranscriptMatchWorkerInput["request"],
    ) => Promise<SessionTranscriptWorkerValues["transcript-match"]["result"]>;
    readHistoricalEvictionCandidates: (
      input: Omit<SessionHistoricalEvictionCandidatesWorkerInput, "kind" | "database">,
    ) => Promise<string[]>;
    readArchivedEvictionCandidates: (
      input: Omit<SessionArchivedEvictionCandidatesWorkerInput, "kind" | "database">,
    ) => Promise<ArchivedSessionEvictionBatch>;
    readArchivePruning: SessionHistoryReader<"session-archive-pruning", "result">;
    readColdMetadata: CancellableSessionHistoryReader<"cold-metadata">;
    readRuntimeTarget: SessionHistoryReader<"session-runtime-target", "target">;
    readColdStorageInventory: SessionHistoryReader<"cold-storage-inventory">;
    searchTranscripts: (
      params: SessionTranscriptSearchWorkerInput["params"],
      readIndexStatus: (signal: AbortSignal) => Promise<boolean>,
    ) => Promise<SessionTranscriptSearchResult>;
    assertCurrent: () => void;
    run: (
      prepare: () => Omit<SessionTranscriptHistoryWorkerInput, "database">,
      inputBytes: number,
    ) => Promise<SessionHistoryWorkerResult>;
    readPreview: SessionHistoryReader<"session-preview", "items">;
    readTitleFields: SessionHistoryReader<"session-title-fields", "fields">;
    readWatermark: SessionHistoryReader<"transcript-watermark", "watermark">;
    readStats: SessionHistoryReader<"transcript-stats", "stats">;
    readActivitySummarySource: SessionHistoryReader<"session-activity-summary-source", "source">;
    readEntryPresence: (scope: SessionRowPresenceWorkerInput["scope"]) => Promise<boolean>;
    readProjectionStatus: CancellableSessionHistoryReader<"projection-status">;
    readIdentityEvidence: SessionHistoryReader<"session-identity-evidence", "evidence">;
    readExactEntries: (
      input: SessionExactEntriesWorkerRequest,
      signal?: AbortSignal,
    ) => Promise<SessionExactEntriesWorkerResult>;
    readRowFacts: SessionHistoryReader<"session-row-facts">;
    readSessionMaintenance: CancellableSessionHistoryReader<"session-maintenance-read">;
    readStoreProjection: SessionHistoryReader<"session-store-projection">;
    readEntries: (
      scope: SessionEntryListWorkerInput["scope"],
      continuation?: CanonicalSessionReaderContinuation,
      expectedIdentity?: SessionEntryListWorkerInput["expectedIdentity"],
      ifRevision?: string,
    ) => Promise<SessionEntryListWorkerResult>;
    readStoreSummary: SessionHistoryReader<"session-store-summary", "summary">;
    readEntryResult: (
      input: Parameters<SessionHistoryReader<"session-entry-read">>[0],
    ) => Promise<
      Result<SessionEntryReadWorkerResult["entry"], unknown> &
        Pick<SessionEntryReadWorkerResult, "source" | "facts">
    >;
    readEntryCurrent: SessionHistoryReader<"session-entry-current", "entry">;
    readDiagnosticText: SessionHistoryReader<"session-diagnostic-text", "text">;
    readMembers: SessionHistoryReader<"session-members">;
    readSuggestions: SessionHistoryReader<"session-suggestions", "suggestions">;
    readReactions: SessionHistoryReader<"session-reactions", "reactions">;
    readMembershipFacts: SessionHistoryReader<"session-membership-facts">;
    readProgressCard: SessionHistoryReader<"session-progress-card", "card">;
    readConversationDelivery: SessionHistoryReader<"conversation-delivery", "record">;
    readGoalOperationReceipt: SessionHistoryReader<"goal-operation-receipt", "result">;
    readPendingInputSource: PendingInputSourceWorker.Reader;
    readHarnessCompletionSource: HarnessCompletionSourceWorker.Reader;
    readPendingInputHistory: SessionHistoryReader<"session-pending-input-history", "snapshot">;
    readPendingInputReceipts: SessionHistoryReader<"session-pending-input-receipts", "receipts">;
    readVoiceSessions: SessionHistoryReader<"voice-sessions">;
  };
