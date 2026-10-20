import type { AcceptedCompactionSuccessor } from "../../agents/embedded-agent-runner/compaction-successor.js";
import type { CompactionRequestBudget } from "../../agents/sessions/compaction/request-budget.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions } from "../types.js";
import type { CompactionNoticePhase } from "./compaction-notice.js";
import type { FollowupRun } from "./queue/types.js";

export type MemoryFlushOutcome = "skipped" | "completed" | "failed" | "exhausted";

export type MemoryFlushResult = {
  sessionEntry?: SessionEntry;
  outcome: MemoryFlushOutcome;
};

export type MemoryFlushRunParams = {
  /** A requested compaction needs its checkpoint even below the token threshold. */
  force?: boolean;
  /** Supplied only by required preflight, while this admitted input is unprocessed. */
  preflightAdmission?: UserTurnTranscriptAdmissionReceipt;
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  opts?: Pick<GetReplyOptions, "promptCacheKey" | "runId">;
  defaultModel: string;
  resolvedVerboseLevel: VerboseLevel;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
  replyOperation?: ReplyOperation;
  abortSignal?: AbortSignal;
};

export type SessionCompactionRunParams = {
  replyOperation?: ReplyOperation;
  pendingUserEntryId?: string;
  compactionRequestBudget?: CompactionRequestBudget;
  requestedCompaction?: import("../../agents/session-maintenance/request.js").SessionCompactionRequest;
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  defaultModel: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
  /** Completed commands carry the actual harness, not the originally requested runtime. */
  agentHarnessId?: string;
  abortSignal?: AbortSignal;
  authorize?: () => boolean;
  beforeCompaction?: (entry: SessionEntry) => Promise<SessionEntry | undefined>;
  onCompactionStart?: () => void;
  onCompactionCommitted?: (accepted: AcceptedCompactionSuccessor) => void;
  onSessionIdChanged?: (sessionId: string) => void;
  onCompactionNotice?: (phase: CompactionNoticePhase, text?: string) => Promise<void> | void;
};
