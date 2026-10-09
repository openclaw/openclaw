import type { Result } from "@openclaw/normalization-core/result";
import type { ProgressCard } from "../../../packages/gateway-protocol/src/index.js";
import type {
  BuildSessionEntryOptions,
  SessionFileEntry,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import type { BoardReadOperations } from "../../boards/sqlite-board-operations.js";
import type { PreparedSessionHistoryReadTarget } from "../../gateway/session-history-read.types.js";
import type {
  SessionRowTranscriptFields,
  SessionRowTranscriptReadParams,
} from "../../gateway/session-row-transcript-backfill.types.js";
import type { SessionPreviewItem, SessionTitleFields } from "../../gateway/session-utils.types.js";
import type { SessionMemoryTranscript } from "../../hooks/bundled/session-memory/capture.types.js";
import type { SessionCostUsageCacheReadResult } from "../../infra/session-cost-usage-cache-read.js";
import type { SensitiveTextRedactionSnapshot } from "../../logging/redact.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawRegisteredAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { VoiceSessionMatch } from "../../talk/client-voice-session-store.js";
import type {
  TrajectoryRetentionWorkerInput,
  TrajectoryRuntimeRetentionPlan,
} from "../../trajectory/runtime-retention.contract.js";
import type {
  SessionActivitySummaryBatchInput,
  SessionActivitySummaryBatchResult,
} from "./activity-summary-source.types.js";
import type {
  SessionCleanupReadInput,
  SessionCleanupReadResult,
} from "./cleanup-service-read.types.js";
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
  TranscriptEvent,
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
  SessionAccessScope,
  SessionEntryReadScope,
  SessionEntrySummary,
  SessionTranscriptReadScope,
} from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type {
  SessionEntryCurrentFacts,
  SessionEntryCurrentSource,
} from "./session-entry-current.types.js";
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
import type { SessionRowDatabaseFacts } from "./session-row-facts.types.js";
import type {
  SessionMembersWorkerInput,
  SessionMembershipFactsWorkerInput,
  SessionSuggestionsWorkerInput,
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
import type { SessionTranscriptSearchResult } from "./session-transcript-search.types.js";
import type { SessionTranscriptWorkerReadError } from "./session-transcript-worker-error.types.js";
import type {
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
  SessionTranscriptMessagePresenceWorkerInput,
  SessionTranscriptDeltaWorkerInput,
  SessionMemoryCaptureWorkerInput,
  SessionProgressCardWorkerInput,
  VoiceSessionsWorkerInput,
  SessionUsageCacheWorkerInput,
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

export type { SessionModelContextWorkerInput } from "./session-transcript-worker-read.types.js";

export type SessionSqliteTargetWorkerInput = {
  kind: "sqlite-target";
  storePath: string;
  agentId?: string;
  defaultAgentId?: string;
  env: NodeJS.ProcessEnv;
  registeredDatabases: readonly Pick<OpenClawRegisteredAgentDatabase, "agentId" | "path">[];
};

export type SessionResetRecallWorkerInput = {
  kind: "session-reset-recall";
  scope: {
    agentId: string;
    sessionId: string;
    sessionKey?: string;
    storePath: string;
  };
  admission?: UserTurnTranscriptAdmissionReceipt;
};

export type SessionEntryWorkerInput = {
  kind: "session-entry";
  absPath: string;
  options: Omit<BuildSessionEntryOptions, "onTranscriptMessage" | "parseYieldEveryLines"> & {
    agentId: string;
    sessionId: string;
    storePath: string;
  };
  admission?: UserTurnTranscriptAdmissionReceipt;
  redaction: SensitiveTextRedactionSnapshot;
};

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

type SessionRowBackfillWorkerInput = {
  kind: "session-row-backfill";
  database: { agentId: string; path: string };
  params: SessionRowTranscriptReadParams;
};

export type SessionRowPresenceWorkerInput = {
  kind: "session-row-presence";
  database: { agentId: string; path: string };
  scope: SessionAccessScope & { databaseAgentId: string };
};

export type SessionEntryCurrentWorkerInput = Omit<SessionEntryReadWorkerInput, "kind"> & {
  kind: "session-entry-current";
  source?: SessionEntryCurrentSource;
};

export type SessionEntryCurrentWorkerResult = {
  kind: "session-entry-current";
  entry: SessionEntryCurrentFacts | undefined;
  source?: CapturedSessionEntryReadSource & { databaseIdentity: string };
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

export type SessionRowFactsWorkerInput = {
  kind: "session-row-facts";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  sessionKeys: readonly string[];
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionRowFactsWorkerResult = {
  kind: "session-row-facts";
  rows: SessionRowDatabaseFacts[];
};

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

export type SessionHistoryWorkerInput =
  | SessionRetirementReadWorkerInput
  | TrajectoryRetentionWorkerInput
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
  | SessionTranscriptMessagePresenceWorkerInput
  | SessionTranscriptDeltaWorkerInput
  | SessionMemoryCaptureWorkerInput
  | SessionTranscriptAnchorsWorkerInput
  | SessionActivitySummarySourceWorkerInput
  | SessionRowBackfillWorkerInput
  | SessionRowPresenceWorkerInput
  | SessionProjectionStatusWorkerInput
  | SessionMembersWorkerInput
  | SessionSuggestionsWorkerInput
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
  | SessionIdentityEvidenceWorkerInput
  | VoiceSessionsWorkerInput
  | SessionUsageCacheWorkerInput
  | SessionTranscriptSearchWorkerInput
  | SessionTranscriptMatchWorkerInput;

export type SessionTranscriptWorkerInput =
  | SessionSqliteTargetWorkerInput
  | SessionHistoryWorkerInput
  | SessionModelContextWorkerInput
  | SessionContextMessagesWorkerInput
  | SessionEntryWorkerInput
  | SessionResetRecallWorkerInput;

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
    "transcript-message-presence": { kind: "transcript-message-presence"; present: boolean };
    "transcript-anchors": { kind: "transcript-anchors"; facts: SessionTranscriptAnchorFacts };
    "session-activity-summary-source": {
      kind: "session-activity-summary-source";
      source: SessionActivitySummaryBatchResult;
    };
    "session-row-backfill": { kind: "session-row-backfill"; fields: SessionRowTranscriptFields };
    "session-row-presence": boolean;
    "projection-status": boolean;
    "session-members": { kind: "session-members" } & SessionMembersSnapshot;
    "session-suggestions": { kind: "session-suggestions"; suggestions: StoredSessionSuggestion[] };
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
    "session-identity-evidence": {
      kind: "session-identity-evidence";
      evidence: SessionIdentityEvidenceResult[];
    };
    "voice-sessions": { kind: "voice-sessions"; matches: VoiceSessionMatch[] };
    "usage-cache": SessionCostUsageCacheReadResult;
    "model-context": ReturnType<typeof readSessionTranscriptModelContext>;
    "context-messages": import("./session-history-read.types.js").SessionTranscriptContextSnapshot;
    "session-reset-recall": {
      cutoff: import("../../../packages/memory-host-sdk/src/host/session-reset-recall.js").SessionResetRecallCutoff;
    };
    "session-entry": {
      entry: SessionFileEntry | null;
      resetRecallCutoff: ReturnType<typeof readSessionEntryResetRecallCutoff>;
    };
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
  Input extends SessionHistoryWorkerInput,
  Value = SessionTranscriptWorkerValues[Input["kind"]],
> = (input: Omit<Input, "kind" | "database">) => Promise<Value>;

type CancellableSessionHistoryReader<
  Input extends SessionHistoryWorkerInput,
  Value = SessionTranscriptWorkerValues[Input["kind"]],
> = (input: Omit<Input, "kind" | "database">, signal?: AbortSignal) => Promise<Value>;

export type SessionHistoryWorkerDatabase = SessionTranscriptInventoryReaders &
  SessionTranscriptHydrationReaders & {
    readRetirement: CancellableSessionHistoryReader<
      SessionRetirementReadWorkerInput,
      SessionRetirementReadResult
    >;
    readTrajectoryRetention: (
      input: Omit<TrajectoryRetentionWorkerInput, "kind" | "database">,
      options: { signal?: AbortSignal; timeoutMs: number },
    ) => Promise<TrajectoryRuntimeRetentionPlan>;
    readCleanup: SessionHistoryReader<SessionCleanupReadInput>;
    readRawDelta: CancellableSessionHistoryReader<
      Extract<SessionTranscriptDeltaWorkerInput, { kind: "transcript-raw-delta" }>,
      SessionTranscriptRawDeltaResult
    >;
    readVisibleDelta: CancellableSessionHistoryReader<
      Extract<SessionTranscriptDeltaWorkerInput, { kind: "transcript-visible-delta" }>,
      SessionTranscriptVisibleMessageDeltaResult
    >;
    readSessionMemoryCapture: CancellableSessionHistoryReader<
      SessionMemoryCaptureWorkerInput,
      SessionMemoryTranscript
    >;
    readBoardSnapshot: SessionHistoryReader<
      BoardSnapshotWorkerInput,
      BoardReadOperations["boards.readSnapshot"]["output"]
    >;
    readBoardWidgetDocument: SessionHistoryReader<
      BoardWidgetDocumentWorkerInput,
      BoardReadOperations["boards.readWidgetDocument"]["output"]
    >;
    readBranchSummaries: CancellableSessionHistoryReader<
      SessionBranchSummaryWorkerInput,
      SessionBranchSummaryReadResult
    >;
    readMessagePresence: CancellableSessionHistoryReader<
      SessionTranscriptMessagePresenceWorkerInput,
      boolean
    >;
    readAnchors: CancellableSessionHistoryReader<
      SessionTranscriptAnchorsWorkerInput,
      SessionTranscriptAnchorFacts
    >;
    readConversations: SessionHistoryReader<ConversationRowsWorkerInput, ConversationRecord[]>;
    prewarm: (input: { env: NodeJS.ProcessEnv }) => Promise<void>;
    readPendingArchives: CancellableSessionHistoryReader<
      SessionPendingArchivesWorkerInput,
      boolean
    >;
    readLifecycleArtifactPlan: CancellableSessionHistoryReader<LifecycleArtifactCleanupRequest>;
    findTranscriptEvent: (
      request: SessionTranscriptMatchWorkerInput["request"],
    ) => Promise<{ event: TranscriptEvent } | undefined>;
    readHistoricalEvictionCandidates: SessionHistoryReader<
      SessionHistoricalEvictionCandidatesWorkerInput,
      string[]
    >;
    readArchivedEvictionCandidates: SessionHistoryReader<
      SessionArchivedEvictionCandidatesWorkerInput,
      ArchivedSessionEvictionBatch
    >;
    readArchivePruning: SessionHistoryReader<
      SessionArchivePruningWorkerInput,
      PublishedSessionTranscriptArchive[]
    >;
    readColdMetadata: SessionHistoryReader<SessionColdMetadataWorkerInput>;
    readRuntimeTarget: SessionHistoryReader<
      SessionRuntimeTargetWorkerInput,
      SessionTranscriptWorkerValues["session-runtime-target"]["target"]
    >;
    readColdStorageInventory: SessionHistoryReader<SessionColdStorageInventoryWorkerInput>;
    searchTranscripts: (
      params: SessionTranscriptSearchWorkerInput["params"],
      readIndexStatus: (signal: AbortSignal) => Promise<boolean>,
    ) => Promise<SessionTranscriptSearchResult>;
    generation: number;
    assertCurrent: () => void;
    run: (
      prepare: () => Omit<SessionTranscriptHistoryWorkerInput, "database">,
      inputBytes: number,
    ) => Promise<SessionHistoryWorkerResult>;
    readPreview: SessionHistoryReader<SessionPreviewWorkerInput, SessionPreviewItem[]>;
    readTitleFields: SessionHistoryReader<SessionTitleFieldsWorkerInput, SessionTitleFields>;
    readWatermark: SessionHistoryReader<
      SessionTranscriptWatermarkWorkerInput,
      SessionTranscriptWatermark
    >;
    readActivitySummarySource: SessionHistoryReader<
      SessionActivitySummarySourceWorkerInput,
      SessionActivitySummaryBatchResult
    >;
    readRowBackfill: (
      params: SessionRowBackfillWorkerInput["params"],
    ) => Promise<SessionRowTranscriptFields>;
    readEntryPresence: (scope: SessionRowPresenceWorkerInput["scope"]) => Promise<boolean>;
    readProjectionStatus: CancellableSessionHistoryReader<SessionProjectionStatusWorkerInput>;
    readIdentityEvidence: SessionHistoryReader<
      SessionIdentityEvidenceWorkerInput,
      SessionIdentityEvidenceResult[]
    >;
    readExactEntries: (
      input: SessionExactEntriesWorkerRequest,
      signal?: AbortSignal,
    ) => Promise<SessionExactEntriesWorkerResult>;
    readRowFacts: SessionHistoryReader<SessionRowFactsWorkerInput>;
    readSessionMaintenance: CancellableSessionHistoryReader<SessionMaintenanceReadWorkerInput>;
    readStoreProjection: SessionHistoryReader<SessionStoreProjectionWorkerInput>;
    readEntries: (
      scope: SessionEntryListWorkerInput["scope"],
      continuation?: CanonicalSessionReaderContinuation,
      expectedIdentity?: SessionEntryListWorkerInput["expectedIdentity"],
    ) => Promise<SessionEntrySummary[]>;
    readStoreSummary: SessionHistoryReader<
      SessionStoreSummaryWorkerInput,
      SessionTranscriptWorkerValues["session-store-summary"]["summary"]
    >;
    readEntryResult: SessionHistoryReader<
      SessionEntryReadWorkerInput,
      Result<SessionEntryReadWorkerResult["entry"], unknown>
    >;
    readEntryCurrent: SessionHistoryReader<
      SessionEntryCurrentWorkerInput,
      SessionEntryCurrentFacts | undefined
    >;
    readDiagnosticText: SessionHistoryReader<SessionDiagnosticTextWorkerInput, string | undefined>;
    readMembers: SessionHistoryReader<SessionMembersWorkerInput>;
    readSuggestions: SessionHistoryReader<SessionSuggestionsWorkerInput, StoredSessionSuggestion[]>;
    readMembershipFacts: SessionHistoryReader<SessionMembershipFactsWorkerInput>;
    readProgressCard: SessionHistoryReader<SessionProgressCardWorkerInput, ProgressCard | null>;
    readConversationDelivery: SessionHistoryReader<
      ConversationDeliveryWorkerInput,
      ConversationDeliveryRecord | undefined
    >;
    readGoalOperationReceipt: SessionHistoryReader<
      SessionGoalOperationReceiptWorkerInput,
      SessionGoalOperationLookupResult
    >;
    readPendingInputSource: PendingInputSourceWorker.Reader;
    readHarnessCompletionSource: HarnessCompletionSourceWorker.Reader;
    readPendingInputHistory: SessionHistoryReader<
      PendingInputHistoryWorkerInput,
      PendingInputHistorySnapshot
    >;
    readPendingInputReceipts: SessionHistoryReader<
      SessionPendingInputReceiptsWorkerInput,
      ReturnType<typeof listSessionPendingInputReceipts>
    >;
    readVoiceSessions: SessionHistoryReader<VoiceSessionsWorkerInput>;
    readUsageCache: SessionHistoryReader<SessionUsageCacheWorkerInput>;
  };
