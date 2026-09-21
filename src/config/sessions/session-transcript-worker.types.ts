import type {
  BuildSessionEntryOptions,
  SessionFileEntry,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import type { PreparedSessionHistoryReadTarget } from "../../gateway/session-history-read.types.js";
import type { SessionTitleFields } from "../../gateway/session-transcript-title-reader.js";
import type { SessionPreviewItem } from "../../gateway/session-utils.types.js";
import type {
  SessionCostUsageCacheRead,
  SessionCostUsageCacheReadResult,
} from "../../infra/session-cost-usage-cache-read.js";
import type { SensitiveTextRedactionSnapshot } from "../../logging/redact.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
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
} from "./session-store-target-inventory.js";
import type {
  SessionTranscriptSearchParams,
  SessionTranscriptSearchResult,
} from "./session-transcript-search.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type SessionTranscriptSearchWorkerInput = {
  kind: "transcript-search";
  database: { agentId: string; path: string };
  params: SessionTranscriptSearchParams;
};

export type SessionTranscriptSearchWorkerResult = {
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
  scope: SessionTranscriptReadScope;
  maxItems: number;
  maxChars: number;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

export type SessionPreviewWorkerResult = {
  kind: "session-preview";
  items: SessionPreviewItem[];
};

export type SessionTitleFieldsWorkerInput = {
  kind: "session-title-fields";
  database: { agentId: string; path: string };
  scope: SessionTranscriptReadScope;
  includeInterSession?: boolean;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

export type SessionTitleFieldsWorkerResult = {
  kind: "session-title-fields";
  fields: SessionTitleFields;
};

export type SessionRowPresenceWorkerInput = {
  kind: "session-row-presence";
  database: { agentId: string; path: string };
  scope: SessionAccessScope & { databaseAgentId: string };
};

export type SessionMembersWorkerInput = {
  kind: "session-members";
  database: { agentId: string; path: string };
  sessionKey: string;
  env: NodeJS.ProcessEnv;
};

export type SessionUsageCacheWorkerInput = {
  kind: "usage-cache";
  database: { agentId: string; path: string };
  request: SessionCostUsageCacheRead;
  env: NodeJS.ProcessEnv;
};

export type SessionEntryListWorkerInput = {
  kind: "session-entry-list";
  database: { agentId: string; path: string };
  scope: SessionEntryListScope;
};

export type SessionEntryListWorkerResult = {
  kind: "session-entry-list";
  entries: SessionEntrySummary[];
};

export type SessionTargetInventoryWorkerInput = {
  kind: "session-target-inventory";
  request: SessionStoreTargetInventoryRequest;
};

export type SessionIdentityEvidenceWorkerInput = {
  kind: "session-identity-evidence";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  identities: readonly SessionIdentityEvidenceIdentity[];
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionIdentityEvidenceWorkerResult = {
  kind: "session-identity-evidence";
  evidence: SessionIdentityEvidenceResult[];
};

export type SessionBranchSummaryWorkerInput = {
  kind: "branch-summaries";
  request: SessionBranchSummaryReadRequest;
};

export type SessionTranscriptWorkerValues = {
  "transcript-search": SessionTranscriptSearchWorkerResult;
  "branch-summaries": SessionBranchSummaryReadResult;
  "history-page": SessionHistoryWorkerResult;
  "session-preview": SessionPreviewWorkerResult;
  "session-title-fields": SessionTitleFieldsWorkerResult;
  "session-row-presence": boolean;
  "session-members": SessionMember[];
  "session-entry-list": SessionEntryListWorkerResult;
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
