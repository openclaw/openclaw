import type { Result } from "@openclaw/normalization-core/result";
import type { ProgressCard } from "../../../packages/gateway-protocol/src/index.js";
import type {
  BuildSessionEntryOptions,
  SessionFileEntry,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import type { PreparedSessionHistoryReadTarget } from "../../gateway/session-history-read.types.js";
import type {
  SessionRowTranscriptFields,
  SessionRowTranscriptReadParams,
} from "../../gateway/session-row-transcript-backfill.types.js";
import type { SessionPreviewItem, SessionTitleFields } from "../../gateway/session-utils.types.js";
import type {
  SessionCostUsageCacheRead,
  SessionCostUsageCacheReadResult,
} from "../../infra/session-cost-usage-cache-read.js";
import type { SensitiveTextRedactionSnapshot } from "../../logging/redact.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawRegisteredAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type {
  SessionActivitySummaryBatchInput,
  SessionActivitySummaryBatchResult,
} from "./activity-summary-source.types.js";
import type { ConversationDeliveryRecord } from "./conversation-delivery-store.types.js";
import type {
  ConversationRowsWorkerInput,
  ConversationRecord,
} from "./conversation-registry.types.js";
import type {
  ArchivedSessionEvictionBatch,
  ArchivedSessionEvictionQuery,
} from "./disk-budget.types.js";
import type { SessionGoalOperationLookupResult } from "./goals-operations.types.js";
import type { SessionLifecycleTimestamps } from "./lifecycle.types.js";
import type {
  SessionPendingArchivesWorkerInput,
  SessionArchivePruningWorkerInput,
} from "./session-accessor.sqlite-archive-types.js";
import type {
  SessionBranchSummaryReadRequest,
  SessionBranchSummaryReadResult,
} from "./session-accessor.sqlite-branches.js";
import type {
  SessionEntryStatusSelection,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import type {
  SessionIdentityEvidenceIdentity,
  SessionIdentityEvidenceResult,
} from "./session-accessor.sqlite-entry-availability.js";
import type {
  LifecycleArtifactCleanupRequest,
  LifecycleArtifactCleanupWorkerResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import type { SessionParticipantRecord } from "./session-accessor.sqlite-participant-projection.js";
import type { listSessionPendingInputReceipts } from "./session-accessor.sqlite-pending-input-receipts.js";
import type { SessionTranscriptMessageEvent } from "./session-accessor.sqlite-projection-read.js";
import type {
  SessionEntryReplacementSelection,
  SessionEntryReplacementState,
} from "./session-accessor.sqlite-replacement-read.js";
import type { SessionTranscriptWatermark } from "./session-accessor.sqlite-transcript-watermark-read.js";
import type {
  SessionAccessScope,
  SessionEntryReadScope,
  SessionEntryListScope,
  SessionEntrySummary,
  SessionTranscriptReadScope,
} from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type { SessionColdArchive } from "./session-cold-storage-state.js";
import type {
  SessionEntryCurrentFacts,
  SessionEntryCurrentSource,
} from "./session-entry-current.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type {
  SessionEntryReadWorkerInput,
  SessionEntryReadWorkerResult,
  SessionRuntimeTargetWorkerInput,
  SessionRuntimeTargetWorkerResult,
} from "./session-entry-read.types.js";
import type * as HarnessCompletionSourceWorker from "./session-harness-completion-source.types.js";
import type { PublishedSessionTranscriptArchive } from "./session-history-archive-pruning.types.js";
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
  SessionMembersWorkerInput,
  SessionMembershipFactsWorkerInput,
  SessionSuggestionsWorkerInput,
} from "./session-sharing-read.types.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import type { StoredSessionSuggestion } from "./session-sharing-store.types.js";
import type { ResolvedSqliteStoreTarget } from "./session-sqlite-target.js";
import type {
  SessionStoreTargetInventoryRequest,
  SessionStoreTargetInventoryResult,
  SessionStoreTargetReadRequest,
  SessionStoreTargetReadResult,
} from "./session-store-target-inventory.js";
import type { SessionTranscriptAnchorFacts } from "./session-transcript-anchor-read.kernel.js";
import type {
  PreparedSessionTranscriptHydration,
  SessionTranscriptCurrentTurnEntryRead,
  SessionTranscriptHydrationWorkerResult,
  SessionTranscriptHydrationWorkerInput,
  SessionTranscriptCurrentTurnEntryWorkerInput,
  SessionTranscriptRecentActiveEventsWorkerInput,
  SessionTranscriptLatestActiveMessageWorkerInput,
  SessionTranscriptMaintenanceWorkerInput,
  SessionTranscriptMaintenanceFacts,
} from "./session-transcript-hydration.types.js";
import type {
  SessionTranscriptInventoryWorkerInput,
  SessionTranscriptInventoryWorkerValues,
  SessionTranscriptInventoryReaders,
} from "./session-transcript-inventory.types.js";
import type { SessionTranscriptSearchResult } from "./session-transcript-search.types.js";
import type { SessionTranscriptWorkerReadError } from "./session-transcript-worker-error.types.js";
import type {
  SessionTranscriptMatchWorkerInput,
  SessionTranscriptSearchWorkerInput,
  SessionTranscriptAnchorsWorkerInput,
  SessionModelContextWorkerInput,
  SessionTranscriptWatermarkWorkerInput,
  SessionTranscriptMessagePresenceWorkerInput,
  SessionProgressCardWorkerInput,
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

export type SessionColdMetadataWorkerInput = {
  kind: "cold-metadata";
  database: { agentId: string; path: string };
  sessionId: string;
  env: NodeJS.ProcessEnv;
};

export type SessionColdMetadataWorkerResult = {
  kind: "cold-metadata";
  archive: Omit<SessionColdArchive, "archive_blob"> | undefined;
};

type SessionColdStorageInventoryWorkerInput = {
  kind: "cold-storage-inventory";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
};

export type SessionRowPresenceWorkerInput = {
  kind: "session-row-presence";
  database: { agentId: string; path: string };
  scope: SessionAccessScope & { databaseAgentId: string };
};

type SessionProjectionStatusWorkerInput = {
  kind: "projection-status";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  sessionId?: string;
};

type SessionUsageCacheWorkerInput = {
  kind: "usage-cache";
  database: { agentId: string; path: string };
  request: SessionCostUsageCacheRead;
  env: NodeJS.ProcessEnv;
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

export type SessionEntryListWorkerInput = {
  kind: "session-entry-list";
  database: { agentId: string; path: string };
  scope: SessionEntryListScope & { cleanupSession?: string };
  continuation?: CanonicalSessionReaderContinuation;
};

type SessionStoreSummaryWorkerInput = {
  kind: "session-store-summary";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  agentIds: readonly string[];
  recentLimit: number;
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionExactEntriesWorkerInput = {
  kind: "session-exact-entries";
  database: { agentId: string; path: string };
} & SessionExactEntriesWorkerRequest;

export type SessionExactEntriesWorkerSelection =
  | {
      sessionKeys: readonly string[];
      selection?: never;
      projection?: "full" | "sharing" | "replacement" | "creation" | "list" | "lifecycle" | "exact";
    }
  | {
      sessionKeys?: never;
      selection: { kind: "session-id"; sessionId: string };
      projection: "sharing";
    };

type SessionExactEntriesWorkerRequest = SessionExactEntriesWorkerSelection & {
  env: NodeJS.ProcessEnv;
  statusSelection?: SessionEntryStatusSelection;
  lifecycleSessionKey?: string;
  /** Reply initialization reads the current row's model parent in this same snapshot. */
  replyInitializationSessionKey?: string;
  includeMembers?: boolean;
  includeParticipantRecords?: boolean;
  includeAuthorization?: boolean;
  replacementSelection?: SessionEntryReplacementSelection;
  creationLabel?: string;
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionExactEntriesWorkerResult = {
  kind: "session-exact-entries";
  entries: SessionEntrySummary[];
  lifecycleTimestamps: SessionLifecycleTimestamps;
  pendingArchives?: boolean;
  statusFound?: boolean;
  databaseIdentity?: {
    identity: string;
    incarnation: string;
    filename: string;
    birthtime?: string;
  };
  members?: Record<string, SessionMember[]>;
  participantRecords?: Record<string, SessionParticipantRecord[]>;
  replacement?: SessionEntryReplacementState & { databaseIdentity: string };
  creation?: import("./session-accessor.sqlite-creation-read.js").SessionCreationSnapshot & {
    databaseIdentity: string;
    databasePath: string;
  };
  sharing?: {
    source: { agentId: string; path: string };
    databaseIdentity: string;
    members: Array<{ sessionKey: string; identityIds: string[] }>;
    placeholders: Array<{ sessionKey: string; sessionId: string }>;
  };
};

export const MAX_SESSION_ROW_FACTS_KEYS = 64;

export type SessionRowDatabaseFacts = SessionEntrySummary & {
  hasBoard: boolean;
  activitySummaryWatermark?: SessionTranscriptWatermark;
};

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

export type SessionBranchSummaryWorkerInput = {
  kind: "branch-summaries";
  request: SessionBranchSummaryReadRequest;
};

type SessionHistoricalEvictionCandidatesWorkerInput = {
  kind: "historical-eviction-candidates";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  admissionIdentities: readonly string[];
  preserveRecentMs?: number | null;
};

type SessionArchivedEvictionCandidatesWorkerInput = Omit<
  SessionHistoricalEvictionCandidatesWorkerInput,
  "admissionIdentities" | "preserveRecentMs"
> & { archived: ArchivedSessionEvictionQuery };

export type SessionHistoryWorkerInput =
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
  | SessionStoreTargetWorkerInput
  | SessionTargetInventoryWorkerInput
  | SessionIdentityEvidenceWorkerInput
  | SessionUsageCacheWorkerInput
  | SessionTranscriptSearchWorkerInput
  | SessionTranscriptMatchWorkerInput;

export type SessionTranscriptWorkerInput =
  | SessionSqliteTargetWorkerInput
  | SessionHistoryWorkerInput
  | SessionModelContextWorkerInput
  | SessionEntryWorkerInput
  | SessionResetRecallWorkerInput
  | SessionBranchSummaryWorkerInput;

type SessionHistoryDatabaseWorkerInput = Extract<SessionHistoryWorkerInput, { database: unknown }>;

type PreparedHistoryInput<Input> = Input extends unknown ? Omit<Input, "database"> : never;
export type SessionHistoryWorkerPreparedInput =
  PreparedHistoryInput<SessionHistoryDatabaseWorkerInput>;

export type SessionTranscriptWorkerValues = SessionTranscriptInventoryWorkerValues & {
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
  "transcript-match": { kind: "transcript-match"; result: { event: TranscriptEvent } | undefined };
  "cold-metadata": SessionColdMetadataWorkerResult;
  "cold-storage-inventory": {
    kind: "cold-storage-inventory";
    hotTranscripts: number;
    coldTranscripts: number;
    embeddedArchiveBytes: number;
  };
  "transcript-hydration": SessionTranscriptHydrationWorkerResult;
  "transcript-maintenance": SessionTranscriptMaintenanceFacts;
  "current-turn-entry": SessionTranscriptCurrentTurnEntryRead;
  "recent-active-events": { kind: "recent-active-events"; events: TranscriptEvent[] };
  "latest-active-message": {
    kind: "latest-active-message";
    message: SessionTranscriptMessageEvent | undefined;
  };
  "sqlite-target": { target: ResolvedSqliteStoreTarget };
  "branch-summaries": SessionBranchSummaryReadResult;
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
  "session-members": SessionMember[];
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
  "session-entry-list": { kind: "session-entry-list"; entries: SessionEntrySummary[] };
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
  "usage-cache": SessionCostUsageCacheReadResult;
  "model-context": ReturnType<typeof readSessionTranscriptModelContext>;
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

export type SessionHistoryWorkerDatabase = SessionTranscriptInventoryReaders & {
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
  readPendingArchives: CancellableSessionHistoryReader<SessionPendingArchivesWorkerInput, boolean>;
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
  readTranscript: CancellableSessionHistoryReader<
    SessionTranscriptHydrationWorkerInput,
    PreparedSessionTranscriptHydration
  >;
  readCurrentTurnEntry: CancellableSessionHistoryReader<SessionTranscriptCurrentTurnEntryWorkerInput>;
  readMaintenance: CancellableSessionHistoryReader<SessionTranscriptMaintenanceWorkerInput>;
  readRecentActiveEvents: CancellableSessionHistoryReader<
    SessionTranscriptRecentActiveEventsWorkerInput,
    TranscriptEvent[]
  >;
  readLatestActiveMessage: CancellableSessionHistoryReader<
    SessionTranscriptLatestActiveMessageWorkerInput,
    SessionTranscriptMessageEvent | undefined
  >;
  readExactEntries: (
    input: SessionExactEntriesWorkerRequest,
    signal?: AbortSignal,
  ) => Promise<SessionExactEntriesWorkerResult>;
  readRowFacts: SessionHistoryReader<SessionRowFactsWorkerInput>;
  readEntries: (
    scope: SessionEntryListWorkerInput["scope"],
    continuation?: CanonicalSessionReaderContinuation,
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
  readUsageCache: SessionHistoryReader<SessionUsageCacheWorkerInput>;
};
