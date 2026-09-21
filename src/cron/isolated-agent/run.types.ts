import type { AgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.types.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { NormalizeReplySkipReason } from "../../auto-reply/reply/normalize-reply-skip-reason.js";
/** Execution and result contracts for isolated cron agent runs. */
import type {
  CronJob,
  CronDeliveryTrace,
  CronResolvedDeliveryState,
  CronNextCheckProposal,
  CronRunOutcome,
  CronRunTelemetry,
} from "../types.js";

/** Pre-run disposition returned when isolated cron work never enters an agent runner. */
export type CronAgentAdmissionDisposition = "session-conflict" | "rejected";

/** Final isolated cron turn result merged into service state and run logs. */
export type RunCronAgentTurnResult = {
  /** Typed pre-run rejection so callers never infer admission state from error prose. */
  admissionDisposition?: CronAgentAdmissionDisposition;
  /** Delivery fact authored by the dispatcher, separate from execution status. */
  deliveryState?: CronResolvedDeliveryState;
  /** Last non-empty agent text output (not truncated). */
  outputText?: string;
  /** Terminal model-reply fact without exposing reply text. */
  replyDisposition?: AgentRunTerminalReplySnapshot["disposition"];
  /** Confirmed target delivery, including matching message-tool sends; unknown is omitted. */
  delivered?: boolean;
  /**
   * `true` when cron attempted announce/direct delivery for this run.
   * This is tracked separately from `delivered` because some announce paths
   * cannot guarantee a final delivery ack synchronously.
   */
  deliveryAttempted?: boolean;
  /** Post-run delivery failure on an otherwise successful isolated turn. */
  deliveryError?: string;
  /** Intentional direct-delivery non-outcome recorded before transport custody. */
  deliverySuppressionReason?: NormalizeReplySkipReason;
  delivery?: CronDeliveryTrace;
  nextCheck?: CronNextCheckProposal;
} & CronRunOutcome &
  CronRunTelemetry;

/** Agent payload accepted by an isolated cron execution. */
export type AgentTurnPayload = Extract<CronJob["payload"], { kind: "agentTurn" }> | null;

/** Runner-start metadata delivered to the outer execution owner. */
export type CronRunnerStartedInfo = {
  lifecycleGeneration?: string;
  isFallback?: boolean;
  provider?: string;
  model?: string;
};

/** Completed prompt result recorded by the outer execution owner. */
export type CronCompletedPromptRun = {
  runResult: EmbeddedAgentRunResult;
  fallbackProvider: string;
  fallbackModel: string;
  runStartedAt: number;
  runEndedAt: number;
};

/** Result envelope returned after an isolated cron prompt completes. */
export type CronExecutionResult = CronCompletedPromptRun & {
  completedPromptRuns: readonly CronCompletedPromptRun[];
};
