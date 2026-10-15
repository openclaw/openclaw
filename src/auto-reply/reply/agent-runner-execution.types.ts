import type {
  CompactionAccountingFact,
  CompactionAccountingTarget,
} from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import type { FailoverReason } from "../../agents/failover/signal.js";
import type { CompactionRequestBudget } from "../../agents/sessions/compaction/request-budget.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { BlockReplyPipeline } from "./block-reply-pipeline.js";
import type { resolveBlockStreamingChunking } from "./block-streaming.js";
import type { CurrentTurnImages } from "./current-turn-images.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun } from "./queue.js";
import type { DirectBlockDelivery } from "./reply-delivery.js";
import type { ReplyMediaContext } from "./reply-media-paths.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { TypingSignaler } from "./typing-mode.js";

export type InternalFollowupRun = FollowupRun & {
  /** Keep admission state out of the public plugin-facing FollowupRun contract. */
  currentTurnImagesPrepared?: true;
  mediaImageLayout?: CurrentTurnImages["mediaImageLayout"];
};

export type CompletedAgentAuthSelection = Pick<
  FollowupRun["run"],
  "authProfileId" | "authProfileIdSource"
>;

/** One attempted runtime fallback candidate and its failure reason. */
export type RuntimeFallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason: FailoverReason;
  status?: number;
  code?: string;
};

/** Presentation counts include target-less events; only captured durable facts may be persisted. */
export type AgentTurnCompaction = {
  count: number;
  durable: Array<Extract<CompactionAccountingFact, { kind: "durable" }>>;
};

type AbortedAgentTurn = {
  kind: "aborted";
  reason: "user" | "restart" | "superseded";
  compaction?: AgentTurnCompaction;
};

/** Internal execution may reject before producing a settled turn. */
export type AgentTurnInternalResult =
  | AbortedAgentTurn
  | SettledAgentTurn
  | {
      kind: "final";
      payload: ReplyPayload;
      resolved?: { provider: string; model: string };
      postCompactionModelFailure?: true;
    };

type SettledAgentTurnBase = {
  kind: "settled";
  /** The runtime's claimed writer, independent of whether it compacted. */
  sessionWriter?: CompactionAccountingTarget;
  maintenanceAuthProfile?: CompletedAgentAuthSelection;
  compactionRequestBudget?: CompactionRequestBudget;
  result: Awaited<ReturnType<typeof runEmbeddedAgent>>;
  resolved: { provider: string; model: string };
  fallback: { exhausted: boolean; attempts: RuntimeFallbackAttempt[] };
  autoCompactionCount: number;
  compaction?: AgentTurnCompaction;
  didLogHeartbeatStrip: boolean;
  /** Captured before cleanup; late settlements remain in the live receipts below. */
  hasDirectlySentBlockReply?: true;
  /** Delivery receipts for direct tool-flush payloads, including retry custody. */
  directBlockDeliveries?: DirectBlockDelivery[];
};

export type SettledAgentTurn = SettledAgentTurnBase &
  (
    | {
        status: "ok";
        terminalFailurePayload?: never;
        postCompactionModelFailure?: never;
      }
    | {
        status: "failed";
        terminalFailurePayload: ReplyPayload;
        postCompactionModelFailure?: true;
      }
  );

/** Closed result shared by foreground and queued agent-turn callers. */
export type AgentTurnExecutionResult = {
  runId: string;
  outcome:
    | SettledAgentTurn
    | AbortedAgentTurn
    | {
        kind: "rejected";
        compaction?: AgentTurnCompaction;
        payload: ReplyPayload;
        resolved?: { provider: string; model: string };
        postCompactionModelFailure?: true;
      };
};

/** Reply inputs shared by admission and runtime execution. */
export type ReplyAgentTurnContext = {
  commandBody: string;
  transcriptCommandBody?: string;
  followupRun: FollowupRun;
  sessionCtx: TemplateContext;
  replyOperation?: ReplyOperation;
  opts?: InternalGetReplyOptions;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: ReturnType<typeof resolveBlockStreamingChunking>;
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  storePath?: string;
  resolvedVerboseLevel: VerboseLevel;
  toolProgressDetail?: "explain" | "raw";
};

/** Inputs shared by direct and queued agent-turn execution. */
export type AgentTurnParams = ReplyAgentTurnContext & {
  /** The admitted queued delivery owner settles every terminal outcome. */
  completionSource?: "reply-dispatch";
  replyThreading?: TemplateContext["ReplyThreading"];
  resolveVisibleReplyDelivery?: () => Promise<boolean>;
  typingSignals: TypingSignaler;
  blockReplyPipeline: BlockReplyPipeline | null;
  applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  pendingToolTasks: Set<Promise<void>>;
  getActiveSessionEntry: () => SessionEntry | undefined;
  activeSessionStore?: Record<string, SessionEntry>;
  replyMediaContext?: ReplyMediaContext;
  onCompactionNoticePayload?: (payload: ReplyPayload) => Promise<void> | void;
  isRestartRecoveryArmed?: () => Promise<boolean>;
};

export type EmbeddedAgentRunResult = Awaited<ReturnType<typeof runEmbeddedAgent>>;
