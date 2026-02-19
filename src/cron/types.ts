import type { ChannelId } from "../channels/plugins/types.js";

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

export type CronSessionTarget = "main" | "isolated";
export type CronWakeMode = "next-heartbeat" | "now";

export type CronMessageChannel = ChannelId | "last";

export type CronDeliveryMode = "none" | "announce" | "webhook";

export type CronDelivery = {
  mode: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string;
  bestEffort?: boolean;
};

export type CronDeliveryPatch = Partial<CronDelivery>;

export type CronRunStatus = "ok" | "error" | "skipped";

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
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
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

export type CronPayloadPatch =
  | { kind: "systemEvent"; text?: string }
  | {
      kind: "agentTurn";
      message?: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      allowUnsafeExternalContent?: boolean;
      deliver?: boolean;
      channel?: CronMessageChannel;
      to?: string;
      bestEffortDeliver?: boolean;
    };

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  /** Number of consecutive execution errors (reset on success). Used for backoff. */
  consecutiveErrors?: number;
  /** Number of consecutive schedule computation errors. Auto-disables job after threshold. */
  scheduleErrorCount?: number;
};

/**
 * Optional gate script that is evaluated before the agent turn runs.
 *
 * The `command` is executed in a shell (via `execFile`). The agent turn fires
 * only when the gate exits with `triggerExitCode` (default 0).  Any other exit
 * code causes the job to be recorded as `"skipped"` with no agent invocation.
 *
 * The gate itself is time-bounded by `timeoutMs` (default 30 s) to prevent a
 * hung script from blocking the cron lane.
 */
export type CronGate = {
  /** Shell command to execute. Runs in the OS default shell via `execFile`. */
  command: string;
  /**
   * Exit code that allows the agent turn to proceed.
   * Defaults to `0` (conventional "success / condition met").
   */
  triggerExitCode?: number;
  /**
   * Maximum wall-clock milliseconds the gate script may run.
   * Defaults to 30 000 ms (30 s).
   */
  timeoutMs?: number;
};

export type CronJob = {
  id: string;
  agentId?: string;
  /** Origin session namespace for reminder delivery and wake routing. */
  sessionKey?: string;
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
  delivery?: CronDelivery;
  /**
   * Optional gate that must pass before the agent turn is invoked.
   * When present, the gate script runs first; if it exits with a code other
   * than `gate.triggerExitCode` (default 0) the job is skipped silently.
   */
  gate?: CronGate;
  state: CronJobState;
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>;
};

export type CronJobPatch = Partial<Omit<CronJob, "id" | "createdAtMs" | "state" | "payload">> & {
  payload?: CronPayloadPatch;
  delivery?: CronDeliveryPatch;
  /**
   * Set or replace the gate config. Pass `null` to remove an existing gate.
   */
  gate?: CronGate | null;
  state?: Partial<CronJobState>;
};
