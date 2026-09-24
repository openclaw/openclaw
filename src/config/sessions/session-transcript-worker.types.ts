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
import type { AgentDatabaseExecutionFileIdentity } from "../../state/openclaw-agent-execution-contract.js";
import type { SessionLifecycleTimestamps } from "./lifecycle.types.js";
import type { SessionTranscriptBoundedActiveContext } from "./session-accessor.sqlite-active-context.js";
import type {
  SessionBranchSummaryReadRequest,
  SessionBranchSummaryReadResult,
} from "./session-accessor.sqlite-branches.js";
import type {
  SessionTranscriptContextVersion,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import type {
  SessionIdentityEvidenceIdentity,
  SessionIdentityEvidenceResult,
} from "./session-accessor.sqlite-entry-availability.js";
import type {
  readSessionTranscriptModelContext,
  SessionModelContextLimits,
} from "./session-accessor.sqlite-model-context.js";
import type { loadTranscriptReadSnapshotSync } from "./session-accessor.sqlite-read.js";
import type {
  SessionEntryReplacementSelection,
  SessionEntryReplacementState,
} from "./session-accessor.sqlite-replacement-read.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptWatermark } from "./session-accessor.sqlite-transcript-watermark-read.js";
import type {
  SessionAccessScope,
  CapturedSessionEntryReadSource,
  SessionEntryReadScope,
  SessionEntryListScope,
  SessionEntrySummary,
  SessionTranscriptReadScope,
  SessionTranscriptRuntimeTarget,
} from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type { SessionColdArchive } from "./session-cold-storage-state.js";
import type { PublishedSessionTranscriptArchive } from "./session-history-archive-pruning.types.js";
import type {
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
  SessionHistoryDelta,
} from "./session-history-types.js";
import type { SessionMembershipFacts } from "./session-membership-facts.types.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import type { ResolvedSqliteStoreTarget } from "./session-sqlite-target.js";
import type {
  SessionStoreTargetInventoryRequest,
  SessionStoreTargetInventoryResult,
  SessionStoreTargetReadRequest,
  SessionStoreTargetReadResult,
} from "./session-store-target-inventory.js";
import type {
  SessionTranscriptSearchParams,
  SessionTranscriptSearchResult,
} from "./session-transcript-search.types.js";
import type { SessionTranscriptWorkerReadError } from "./session-transcript-worker-error.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

type SessionTranscriptSearchWorkerInput = {
  kind: "transcript-search";
  database: { agentId: string; path: string };
  params: SessionTranscriptSearchParams;
};

type SessionTranscriptSearchWorkerResult = {
  kind: "transcript-search";
  result: SessionTranscriptSearchResult;
};

export type PreparedSessionTranscriptHydration =
  | { kind: "full"; snapshot: ReturnType<typeof loadTranscriptReadSnapshotSync> }
  | { kind: "bounded"; snapshot: SessionTranscriptBoundedActiveContext };

export type SessionTranscriptHydrationWorkerResult =
  | {
      kind: "full";
      version: ReturnType<typeof loadTranscriptReadSnapshotSync>["version"];
      eventCount: number;
    }
  | Extract<PreparedSessionTranscriptHydration, { kind: "bounded" }>;

export type SessionTranscriptHydrationChunk = {
  kind: "transcript-hydration-chunk";
  encoding: string;
  frames: Array<{ data: Uint8Array; endOfEvent: boolean }>;
};

export type SessionTranscriptCurrentTurnEntryRequest = {
  entryId: string;
  version: SessionTranscriptContextVersion;
  includeEntry: boolean;
};

export type SessionTranscriptCurrentTurnEntryRead = {
  kind: "current-turn-entry";
  version: SessionTranscriptContextVersion;
  anchor?: TranscriptEntryAnchor;
  event?: TranscriptEvent;
};

export type SessionModelContextWorkerInput = {
  kind: "model-context";
  target: SessionTranscriptRuntimeTarget;
  admission?: UserTurnTranscriptAdmissionReceipt;
  through?: TranscriptEntryAnchor;
  limits?: SessionModelContextLimits;
};

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

type SessionPreviewWorkerResult = {
  kind: "session-preview";
  items: SessionPreviewItem[];
};

type SessionTitleFieldsWorkerInput = {
  kind: "session-title-fields";
  database: { agentId: string; path: string };
  scope: SessionTranscriptReadScope;
  includeInterSession?: boolean;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

type SessionTitleFieldsWorkerResult = {
  kind: "session-title-fields";
  fields: SessionTitleFields;
};

type SessionRowBackfillWorkerInput = {
  kind: "session-row-backfill";
  database: { agentId: string; path: string };
  params: SessionRowTranscriptReadParams;
};

type SessionRowBackfillWorkerResult = {
  kind: "session-row-backfill";
  fields: SessionRowTranscriptFields;
};

type SessionTranscriptHydrationWorkerInput = {
  kind: "transcript-hydration";
  database: { agentId: string; path: string };
  target: SessionTranscriptRuntimeTarget & { env?: NodeJS.ProcessEnv };
  resolvedScope: ResolvedTranscriptReadScope;
  limits?: { maxBytes: number; maxEvents: number };
  admission?: UserTurnTranscriptAdmissionReceipt;
};

type SessionTranscriptCurrentTurnEntryWorkerInput = Omit<
  SessionTranscriptHydrationWorkerInput,
  "kind" | "limits"
> &
  SessionTranscriptCurrentTurnEntryRequest & { kind: "current-turn-entry" };

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

export type SessionRowPresenceWorkerInput = {
  kind: "session-row-presence";
  database: { agentId: string; path: string };
  scope: SessionAccessScope & { databaseAgentId: string };
};

type SessionMembersWorkerInput = {
  kind: "session-members";
  database: { agentId: string; path: string };
  sessionKey: string;
  env: NodeJS.ProcessEnv;
};

type SessionMembershipFactsWorkerInput = {
  kind: "session-membership-facts";
  database: { agentId: string; path: string };
  sessionKeys?: readonly string[];
  env: NodeJS.ProcessEnv;
  continuation?: CanonicalSessionReaderContinuation;
};

type SessionProgressCardWorkerInput = {
  kind: "session-progress-card";
  database: { agentId: string; path: string };
  sessionKey: string;
  env: NodeJS.ProcessEnv;
};

type SessionUsageCacheWorkerInput = {
  kind: "usage-cache";
  database: { agentId: string; path: string };
  request: SessionCostUsageCacheRead;
  env: NodeJS.ProcessEnv;
};

type SessionEntryReadWorkerInput = {
  kind: "session-entry-read";
  database: { agentId: string; path: string };
  scope: SessionEntryReadScope & { databaseAgentId: string };
  continuation?: CanonicalSessionReaderContinuation;
};

type SessionEntryReadWorkerResult = {
  kind: "session-entry-read";
  source?: CapturedSessionEntryReadSource & { databaseIdentity: string };
} & (
  | { entry: import("./types.js").SessionEntry | undefined; readError?: never }
  | {
      entry: undefined;
      readError: import("./session-transcript-worker-error.types.js").SessionTranscriptWorkerReadError;
    }
);

type SessionEntryListWorkerInput = {
  kind: "session-entry-list";
  database: { agentId: string; path: string };
  scope: SessionEntryListScope;
};

type SessionEntryListWorkerResult = {
  kind: "session-entry-list";
  entries: SessionEntrySummary[];
};

export type SessionExactEntriesWorkerInput = {
  kind: "session-exact-entries";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  sessionKeys: readonly string[];
  lifecycleSessionKey?: string;
  projection?: "full" | "backing" | "sharing" | "replacement" | "creation";
  includeMembers?: boolean;
  includeParticipantRecords?: boolean;
  includeAuthorization?: boolean;
  replacementSelection?: SessionEntryReplacementSelection;
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionExactEntriesWorkerResult = {
  kind: "session-exact-entries";
  entries: SessionEntrySummary[];
  lifecycleTimestamps: SessionLifecycleTimestamps;
  databaseIdentity?: {
    identity: string;
    incarnation: string;
    filename: string;
    birthtime?: string;
  };
  members?: Record<string, SessionMember[]>;
  participantRecords?: Record<
    string,
    import("./session-accessor.sqlite-participant-projection.js").SessionParticipantRecord[]
  >;
  replacement?: SessionEntryReplacementState & { databaseIdentity: string };
  creation?: import("./session-accessor.sqlite-creation-read.js").SessionCreationSnapshot & {
    databaseIdentity: string;
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

type SessionIdentityEvidenceWorkerResult = {
  kind: "session-identity-evidence";
  evidence: SessionIdentityEvidenceResult[];
};

export type SessionBranchSummaryWorkerInput = {
  kind: "branch-summaries";
  request: SessionBranchSummaryReadRequest;
};

export type SessionArchivePruningWorkerInput = {
  kind: "session-archive-pruning";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  expectedIdentity: AgentDatabaseExecutionFileIdentity;
};

type SessionHistoricalEvictionCandidatesWorkerInput = {
  kind: "historical-eviction-candidates";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  admissionIdentities: readonly string[];
  preserveRecentMs?: number | null;
};

export type SessionHistoryWorkerInput =
  | SessionHistoricalEvictionCandidatesWorkerInput
  | SessionArchivePruningWorkerInput
  | SessionColdMetadataWorkerInput
  | SessionTranscriptHydrationWorkerInput
  | SessionTranscriptCurrentTurnEntryWorkerInput
  | SessionTranscriptHistoryWorkerInput
  | SessionPreviewWorkerInput
  | SessionTitleFieldsWorkerInput
  | SessionRowBackfillWorkerInput
  | SessionRowPresenceWorkerInput
  | SessionMembersWorkerInput
  | SessionMembershipFactsWorkerInput
  | SessionProgressCardWorkerInput
  | SessionEntryListWorkerInput
  | SessionEntryReadWorkerInput
  | SessionExactEntriesWorkerInput
  | SessionRowFactsWorkerInput
  | SessionStoreTargetWorkerInput
  | SessionTargetInventoryWorkerInput
  | SessionIdentityEvidenceWorkerInput
  | SessionUsageCacheWorkerInput
  | SessionTranscriptSearchWorkerInput;

export type SessionTranscriptWorkerInput =
  | SessionSqliteTargetWorkerInput
  | SessionHistoryWorkerInput
  | SessionModelContextWorkerInput
  | SessionEntryWorkerInput
  | SessionResetRecallWorkerInput
  | SessionBranchSummaryWorkerInput;

type SessionHistoryDatabaseWorkerInput = Extract<SessionHistoryWorkerInput, { database: unknown }>;

export type SessionHistoryWorkerPreparedInput = {
  [Input in SessionHistoryDatabaseWorkerInput as Input["kind"]]: Omit<Input, "database">;
}[SessionHistoryDatabaseWorkerInput["kind"]];

export type SessionTranscriptWorkerValues = {
  "historical-eviction-candidates": {
    kind: "historical-eviction-candidates";
    sessionIds: string[];
  };
  "session-archive-pruning": {
    kind: "session-archive-pruning";
    result: PublishedSessionTranscriptArchive | null;
  };
  "transcript-search": SessionTranscriptSearchWorkerResult;
  "cold-metadata": SessionColdMetadataWorkerResult;
  "transcript-hydration": SessionTranscriptHydrationWorkerResult;
  "current-turn-entry": SessionTranscriptCurrentTurnEntryRead;
  "sqlite-target": { target: ResolvedSqliteStoreTarget };
  "branch-summaries": SessionBranchSummaryReadResult;
  "history-page": SessionHistoryWorkerResult;
  "session-preview": SessionPreviewWorkerResult;
  "session-title-fields": SessionTitleFieldsWorkerResult;
  "session-row-backfill": SessionRowBackfillWorkerResult;
  "session-row-presence": boolean;
  "session-members": SessionMember[];
  "session-membership-facts": SessionMembershipFacts;
  "session-progress-card": { kind: "session-progress-card"; card: ProgressCard | null };
  "session-entry-list": SessionEntryListWorkerResult;
  "session-entry-read": SessionEntryReadWorkerResult;
  "session-exact-entries": SessionExactEntriesWorkerResult;
  "session-row-facts": SessionRowFactsWorkerResult;
  "session-store-target":
    | SessionStoreTargetReadResult
    | {
        kind: "session-store-target";
        readError: import("./session-transcript-worker-error.types.js").SessionTranscriptWorkerReadError;
      };
  "session-target-inventory": SessionStoreTargetInventoryResult;
  "session-identity-evidence": SessionIdentityEvidenceWorkerResult;
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

type SessionTranscriptWorkerError =
  | SessionTranscriptWorkerReadError
  | { kind: "delta-visibility"; partial: SessionHistoryDelta };

export type SessionTranscriptWorkerReply<Kind extends keyof SessionTranscriptWorkerValues> =
  | {
      ok: true;
      value: SessionTranscriptWorkerValues[Kind];
      closedHistoryDatabase?: SessionTranscriptHistoryWorkerInput["database"];
    }
  | {
      ok: false;
      error: SessionTranscriptWorkerError;
    };

export type SessionHistoryWorkerDatabase = {
  readHistoricalEvictionCandidates: (
    input: Omit<SessionHistoricalEvictionCandidatesWorkerInput, "kind" | "database">,
  ) => Promise<string[]>;
  readArchivePruning: (
    input: Omit<SessionArchivePruningWorkerInput, "kind" | "database">,
  ) => Promise<PublishedSessionTranscriptArchive | null>;
  readColdMetadata: (
    input: Omit<SessionColdMetadataWorkerInput, "kind" | "database">,
  ) => Promise<SessionColdMetadataWorkerResult>;
  searchTranscripts: (
    params: SessionTranscriptSearchWorkerInput["params"],
  ) => Promise<SessionTranscriptSearchWorkerResult["result"]>;
  generation: number;
  assertCurrent: () => void;
  run: (
    prepare: () => Omit<SessionTranscriptHistoryWorkerInput, "database">,
    inputBytes: number,
  ) => Promise<SessionHistoryWorkerResult>;
  readPreview: (
    input: Omit<SessionPreviewWorkerInput, "kind" | "database">,
  ) => Promise<SessionPreviewWorkerResult["items"]>;
  readTitleFields: (
    input: Omit<SessionTitleFieldsWorkerInput, "kind" | "database">,
  ) => Promise<SessionTitleFieldsWorkerResult["fields"]>;
  readRowBackfill: (
    params: SessionRowBackfillWorkerInput["params"],
  ) => Promise<SessionRowBackfillWorkerResult["fields"]>;
  readEntryPresence: (scope: SessionRowPresenceWorkerInput["scope"]) => Promise<boolean>;
  readIdentityEvidence: (
    input: Omit<SessionIdentityEvidenceWorkerInput, "kind" | "database">,
  ) => Promise<SessionIdentityEvidenceResult[]>;
  readTranscript: (
    input: Omit<SessionTranscriptHydrationWorkerInput, "kind" | "database">,
    signal?: AbortSignal,
  ) => Promise<PreparedSessionTranscriptHydration>;
  readCurrentTurnEntry: (
    input: Omit<SessionTranscriptCurrentTurnEntryWorkerInput, "kind" | "database">,
    signal?: AbortSignal,
  ) => Promise<SessionTranscriptCurrentTurnEntryRead>;
  readExactEntries: (
    input: Omit<SessionExactEntriesWorkerInput, "kind" | "database">,
    signal?: AbortSignal,
  ) => Promise<SessionExactEntriesWorkerResult>;
  readRowFacts: (
    input: Omit<SessionRowFactsWorkerInput, "kind" | "database">,
  ) => Promise<SessionRowFactsWorkerResult>;
  readEntries: (
    scope: SessionEntryListWorkerInput["scope"],
  ) => Promise<SessionEntryListWorkerResult["entries"]>;
  readEntryResult: (
    input: Omit<SessionEntryReadWorkerInput, "kind" | "database">,
  ) => Promise<
    import("@openclaw/normalization-core/result").Result<
      SessionEntryReadWorkerResult["entry"],
      unknown
    >
  >;
  readMembers: (
    input: Omit<SessionMembersWorkerInput, "kind" | "database">,
  ) => Promise<SessionMember[]>;
  readMembershipFacts: (
    input: Omit<SessionMembershipFactsWorkerInput, "kind" | "database">,
  ) => Promise<SessionMembershipFacts>;
  readProgressCard: (
    input: Omit<SessionProgressCardWorkerInput, "kind" | "database">,
  ) => Promise<ProgressCard | null>;
  readUsageCache: (
    input: Omit<SessionUsageCacheWorkerInput, "kind" | "database">,
  ) => Promise<SessionCostUsageCacheReadResult>;
};
