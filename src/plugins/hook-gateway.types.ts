/** Gateway lifecycle and cron hook contracts shared by plugin hosts and consumers. */
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type PluginHookGatewayContext = {
  port?: number;
  config?: OpenClawConfig;
  workspaceDir?: string;
  getCron?: () => PluginHookGatewayCronService | undefined;
  /** In gateway_start, aborts at drain to stop producers; gateway_stop owns resource disposal. */
  abortSignal?: AbortSignal;
};

export type PluginHookCronReconciledContext = PluginHookGatewayContext & {
  /** Aborts when this exact scheduler snapshot is superseded or the Gateway closes. */
  abortSignal: AbortSignal;
};

export type PluginHookGatewayStartEvent = {
  port: number;
};

export type PluginHookGatewayStopEvent = {
  reason?: string;
};

export type PluginHookCronReconciledEvent = {
  reason: "startup" | "reload";
  enabled: boolean;
};

type PluginHookGatewayCronRunStatus = "ok" | "error" | "skipped";

type PluginHookGatewayCronDeliveryStatus =
  | "not-requested"
  | "delivered"
  | "not-delivered"
  | "unknown";

type PluginHookGatewayCronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: PluginHookGatewayCronRunStatus;
  lastError?: string;
  lastDurationMs?: number;
  lastDelivered?: boolean;
  lastDeliveryStatus?: PluginHookGatewayCronDeliveryStatus;
  lastDeliveryError?: string;
  deliverySuppressionReason?: string;
  lastFailureNotificationDelivered?: boolean;
  lastFailureNotificationDeliveryStatus?: PluginHookGatewayCronDeliveryStatus;
  lastFailureNotificationDeliveryError?: string;
  streamStatus?: "starting" | "running" | "restarting" | "stopped" | "disabled" | "error";
  streamError?: string;
  streamConsecutiveFailures?: number;
  streamRestartExhausted?: boolean;
  streamDroppedBatches?: number;
  streamCoalescedBatches?: number;
  streamLastStartedAtMs?: number;
  streamLastExitAtMs?: number;
};

export type PluginHookGatewayCronJob = {
  id: string;
  declarationKey?: string;
  /** Agent id that owns this cron job. */
  agentId?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?:
    | {
        kind: "cron";
        expr?: string;
        tz?: string;
        staggerMs?: number;
      }
    | {
        kind: "at";
        at?: string;
      }
    | {
        kind: "every";
        everyMs?: number;
        anchorMs?: number;
      }
    | {
        kind: "on-exit";
        command?: string;
        cwd?: string;
      }
    | {
        kind: "stream";
        command?: string[];
        cwd?: string;
        mode?: "line" | "match";
        match?: string;
        batchMs?: number;
        maxBatchBytes?: number;
      };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: {
    kind?: string;
    text?: string;
  };
  state?: PluginHookGatewayCronJobState;
  createdAtMs?: number;
  updatedAtMs?: number;
};

export type PluginHookCronChangedEvent = {
  action: "added" | "updated" | "removed" | "started" | "finished" | "scheduled";
  jobId: string;
  job?: PluginHookGatewayCronJob;
  /** Top-level session target for downstream routing (mirrors job.sessionTarget). */
  sessionTarget?: string;
  /** Agent id that owns this cron job (mirrors job.agentId). */
  agentId?: string;
  runAtMs?: number;
  durationMs?: number;
  status?: PluginHookGatewayCronRunStatus;
  completionStatus?: "succeeded" | "failed" | "unknown";
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: PluginHookGatewayCronDeliveryStatus;
  deliveryError?: string;
  deliverySuppressionReason?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
};

type PluginHookGatewayCronCreateInput = {
  declarationKey?: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: {
    kind: string;
    expr: string;
    tz?: string;
  };
  sessionTarget: string;
  wakeMode: string;
  payload: {
    kind: string;
    text?: string;
  };
};

type PluginHookGatewayCronUpdateInput = Partial<PluginHookGatewayCronCreateInput>;

type PluginHookGatewayCronRemoveResult = {
  removed?: boolean;
};

export type PluginHookGatewayCronService = {
  /** Effective automatic scheduling state; older hosts may omit this observation. */
  isEnabled?: () => Promise<boolean>;
  list: (opts?: { includeDisabled?: boolean }) => Promise<PluginHookGatewayCronJob[]>;
  add: (input: PluginHookGatewayCronCreateInput) => Promise<unknown>;
  update: (id: string, patch: PluginHookGatewayCronUpdateInput) => Promise<unknown>;
  remove: (id: string) => Promise<PluginHookGatewayCronRemoveResult>;
  removeStaleJobFamily: (family: {
    declarationKey: string;
    name: string;
    ownerPluginTag: string;
  }) => Promise<number>;
};
