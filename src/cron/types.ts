import type { FailoverReason } from "../agents/pi-embedded-helpers.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { CronJobBase } from "./types-shared.js";

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | {
      kind: "cron";
      expr: string;
      tz?: string;
      /** Optional deterministic stagger window in milliseconds (0 keeps exact schedule). */
      staggerMs?: number;
    };

export type CronSessionTarget = "main" | "isolated" | "current" | `session:${string}`;
export type CronWakeMode = "next-heartbeat" | "now";

export type CronMessageChannel = ChannelId | "last";

export type CronDeliveryMode = "none" | "announce" | "webhook";

export type CronDelivery = {
  mode: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string;
  /** Explicit channel account id for multi-account setups (e.g. multiple Telegram bots). */
  accountId?: string;
  bestEffort?: boolean;
  /** Separate destination for failure notifications. */
  failureDestination?: CronFailureDestination;
};

export type CronFailureDestination = {
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};

export type CronDeliveryPatch = Partial<CronDelivery>;

export type CronRunStatus = "ok" | "error" | "skipped";
export type CronDeliveryStatus = "delivered" | "not-delivered" | "unknown" | "not-requested";

/**
 * Pre-check gate: a lightweight shell command that runs before the agent turn.
 * If the command exits 0 and produces non-empty stdout, the job proceeds with
 * stdout as context. If it exits non-zero or produces empty stdout, the job
 * is skipped — saving tokens when there's nothing to do.
 *
 * Example: `preCheck: { command: "gh pr list --state open --json number | jq 'if length > 0 then . else empty end'" }`
 * Only wakes the agent when there are open PRs.
 */
export type CronPreCheck = {
  /** Shell command to execute. Runs in the agent workspace directory. */
  command: string;
  /** Timeout in seconds (default: 30). Killed + skipped on timeout. */
  timeoutSeconds?: number;
  /**
   * What to do with stdout when the check passes:
   * - "prepend" (default): prepend stdout to the agent message/system-event as context
   * - "replace": use stdout as the entire message (replaces payload text/message)
   * - "ignore": discard stdout, just use the gate result
   */
  outputMode?: "prepend" | "replace" | "ignore";
};

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "agentTurn";
      message: string;
      /** Optional model override (provider/model or alias). */
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      allowUnsafeExternalContent?: boolean;
      deliver?: boolean;
      channel?: CronMessageChannel;
      to?: string;
      bestEffortDeliver?: boolean;
    };

export type CronUsageSummary = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};

export type CronRunTelemetry = {
  model?: string;
  provider?: string;
  usage?: CronUsageSummary;
};

export type CronRunOutcome = {
  status: CronRunStatus;
  error?: string;
  /** Optional classifier for execution errors to guide fallback behavior. */
  errorKind?: "delivery-target";
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
};

export type CronFailureAlert = {
  after?: number;
  channel?: CronMessageChannel;
  to?: string;
  cooldownMs?: number;
  /** Delivery mode: announce (via messaging channels) or webhook (HTTP POST). */
  mode?: "announce" | "webhook";
  /** Account ID for multi-account channel configurations. */
  accountId?: string;
};

export type CronPayload = { kind: "systemEvent"; text: string } | CronAgentTurnPayload;

export type CronPayloadPatch = { kind: "systemEvent"; text?: string } | CronAgentTurnPayloadPatch;

type CronAgentTurnPayloadFields = {
  message: string;
  /** Optional model override (provider/model or alias). */
  model?: string;
  /** Optional per-job fallback models; overrides agent/global fallbacks when defined. */
  fallbacks?: string[];
  thinking?: string;
  timeoutSeconds?: number;
  allowUnsafeExternalContent?: boolean;
  /** If true, run with lightweight bootstrap context. */
  lightContext?: boolean;
  deliver?: boolean;
  channel?: CronMessageChannel;
  to?: string;
  bestEffortDeliver?: boolean;
};

type CronAgentTurnPayload = {
  kind: "agentTurn";
} & CronAgentTurnPayloadFields;

type CronAgentTurnPayloadPatch = {
  kind: "agentTurn";
} & Partial<CronAgentTurnPayloadFields>;
export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  /** Preferred execution outcome field. */
  lastRunStatus?: CronRunStatus;
  /** Back-compat alias for lastRunStatus. */
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  /** Classified reason for the last error (when available). */
  lastErrorReason?: FailoverReason;
  lastDurationMs?: number;
  /** Number of consecutive execution errors (reset on success). Used for backoff. */
  consecutiveErrors?: number;
  /** Last failure alert timestamp (ms since epoch) for cooldown gating. */
  lastFailureAlertAtMs?: number;
  /** Number of consecutive schedule computation errors. Auto-disables job after threshold. */
  scheduleErrorCount?: number;
  /** Explicit delivery outcome, separate from execution outcome. */
  lastDeliveryStatus?: CronDeliveryStatus;
  /** Delivery-specific error text when available. */
  lastDeliveryError?: string;
  /** Whether the last run's output was delivered to the target channel. */
  lastDelivered?: boolean;
};

export type CronJob = {
  id: string;
  agentId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  /** Optional pre-check gate. Runs a shell command before the agent turn;
   *  skips the job (no tokens spent) if the command fails or returns empty. */
  preCheck?: CronPreCheck;
  delivery?: CronDelivery;
  failureAlert?: CronFailureAlert | false;
  state: CronJobState;
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>;
};

export type CronPreCheckPatch = Partial<CronPreCheck>;

export type CronJobPatch = Partial<
  Omit<CronJob, "id" | "createdAtMs" | "state" | "payload" | "preCheck">
> & {
  payload?: CronPayloadPatch;
  preCheck?: CronPreCheckPatch | null;
  delivery?: CronDeliveryPatch;
  state?: Partial<CronJobState>;
};
