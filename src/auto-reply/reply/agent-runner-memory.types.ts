import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun } from "./queue/types.js";

export type MemoryFlushOutcome = "skipped" | "completed" | "failed" | "exhausted";

export type MemoryFlushResult = {
  sessionEntry?: SessionEntry;
  outcome: MemoryFlushOutcome;
};

export type MemoryFlushRunParams = {
  /** Provider-confirmed pressure bypasses only the proactive threshold. */
  recoveryContextTokenBudget?: number;
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
  replyOperation?: ReplyOperation;
  abortSignal?: AbortSignal;
};
