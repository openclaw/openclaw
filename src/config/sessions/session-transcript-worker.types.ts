import type {
  BuildSessionEntryOptions,
  SessionFileEntry,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import type { PreparedSessionHistoryReadTarget } from "../../gateway/session-history-read.types.js";
import type { SessionPreviewItem, SessionTitleFields } from "../../gateway/session-utils.types.js";
import type {
  SessionCostUsageCacheRead,
  SessionCostUsageCacheReadResult,
} from "../../infra/session-cost-usage-cache-read.js";
import type { SensitiveTextRedactionSnapshot } from "../../logging/redact.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { SessionLifecycleTimestamps } from "./lifecycle.types.js";
import type {
  SessionBranchSummaryReadRequest,
  SessionBranchSummaryReadResult,
} from "./session-accessor.sqlite-branches.js";
import type {
  SessionIdentityEvidenceIdentity,
  SessionIdentityEvidenceResult,
} from "./session-accessor.sqlite-entry-availability.js";
import type {
  readSessionTranscriptModelContext,
  SessionModelContextLimits,
} from "./session-accessor.sqlite-model-context.js";
import type {
  SessionAccessScope,
  SessionEntryListScope,
  SessionEntrySummary,
  SessionTranscriptReadScope,
  SessionTranscriptRuntimeTarget,
} from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type {
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
} from "./session-history-types.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
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

export type SessionModelContextWorkerInput = {
  kind: "model-context";
  target: SessionTranscriptRuntimeTarget;
  admission?: UserTurnTranscriptAdmissionReceipt;
  through?: TranscriptEntryAnchor;
  limits?: SessionModelContextLimits;
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

type SessionUsageCacheWorkerInput = {
  kind: "usage-cache";
  database: { agentId: string; path: string };
  request: SessionCostUsageCacheRead;
  env: NodeJS.ProcessEnv;
};

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
  projection?: "full" | "backing";
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionExactEntriesWorkerResult = {
  kind: "session-exact-entries";
  entries: SessionEntrySummary[];
  lifecycleTimestamps: SessionLifecycleTimestamps;
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

export type SessionHistoryWorkerInput =
  | SessionTranscriptHistoryWorkerInput
  | SessionPreviewWorkerInput
  | SessionTitleFieldsWorkerInput
  | SessionRowPresenceWorkerInput
  | SessionMembersWorkerInput
  | SessionEntryListWorkerInput
  | SessionExactEntriesWorkerInput
  | SessionStoreTargetWorkerInput
  | SessionTargetInventoryWorkerInput
  | SessionIdentityEvidenceWorkerInput
  | SessionUsageCacheWorkerInput
  | SessionTranscriptSearchWorkerInput;

export type SessionTranscriptWorkerInput =
  | SessionHistoryWorkerInput
  | SessionModelContextWorkerInput
  | SessionEntryWorkerInput
  | SessionBranchSummaryWorkerInput;

type SessionHistoryDatabaseWorkerInput = Extract<SessionHistoryWorkerInput, { database: unknown }>;

export type SessionHistoryWorkerPreparedInput = {
  [Input in SessionHistoryDatabaseWorkerInput as Input["kind"]]: Omit<Input, "database">;
}[SessionHistoryDatabaseWorkerInput["kind"]];

export type SessionTranscriptWorkerValues = {
  "transcript-search": SessionTranscriptSearchWorkerResult;
  "branch-summaries": SessionBranchSummaryReadResult;
  "history-page": SessionHistoryWorkerResult;
  "session-preview": SessionPreviewWorkerResult;
  "session-title-fields": SessionTitleFieldsWorkerResult;
  "session-row-presence": boolean;
  "session-members": SessionMember[];
  "session-entry-list": SessionEntryListWorkerResult;
  "session-exact-entries": SessionExactEntriesWorkerResult;
  "session-store-target": SessionStoreTargetReadResult;
  "session-target-inventory": SessionStoreTargetInventoryResult;
  "session-identity-evidence": SessionIdentityEvidenceWorkerResult;
  "usage-cache": SessionCostUsageCacheReadResult;
  "model-context": ReturnType<typeof readSessionTranscriptModelContext>;
  "session-entry": {
    entry: SessionFileEntry | null;
    resetRecallCutoff: ReturnType<typeof readSessionEntryResetRecallCutoff>;
  };
};

export type SessionTranscriptWorkerReply<Kind extends keyof SessionTranscriptWorkerValues> =
  | {
      ok: true;
      value: SessionTranscriptWorkerValues[Kind];
      closedHistoryDatabase?: SessionTranscriptHistoryWorkerInput["database"];
    }
  | {
      ok: false;
      error:
        | { kind: "cold"; sessionId: string }
        | { kind: "projection"; sessionId: string }
        | { kind: "fence"; message: string }
        | { kind: "syntax"; message: string };
    };

export type SessionHistoryWorkerDatabase = {
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
  readEntryPresence: (scope: SessionRowPresenceWorkerInput["scope"]) => Promise<boolean>;
  readIdentityEvidence: (
    input: Omit<SessionIdentityEvidenceWorkerInput, "kind" | "database">,
  ) => Promise<SessionIdentityEvidenceResult[]>;
  readExactEntries: (
    input: Omit<SessionExactEntriesWorkerInput, "kind" | "database">,
  ) => Promise<SessionExactEntriesWorkerResult>;
  readEntries: (
    scope: SessionEntryListWorkerInput["scope"],
  ) => Promise<SessionEntryListWorkerResult["entries"]>;
  readMembers: (
    input: Omit<SessionMembersWorkerInput, "kind" | "database">,
  ) => Promise<SessionMember[]>;
  readUsageCache: (
    input: Omit<SessionUsageCacheWorkerInput, "kind" | "database">,
  ) => Promise<SessionCostUsageCacheReadResult>;
};
