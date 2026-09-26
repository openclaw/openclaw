import type { PluginJsonValue } from "./host-hook-json.js";

export type PluginHookGatewayCronRunStatus = "ok" | "error" | "skipped";

export type PluginHookGatewayCronDeliveryStatus =
  | "not-requested"
  | "delivered"
  | "not-delivered"
  | "unknown";

type PluginHookGatewayCronJobState = {
  triggerState?: unknown;
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
  owner?: { agentId?: string; sessionKey?: string };
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

type PluginHookGatewayCronTriggerStateMutation = {
  key: string;
  expectedRevision: number;
  value: { [key: string]: PluginJsonValue };
};

type PluginHookGatewayCronRemoveResult = {
  removed?: boolean;
};

export type PluginHookGatewayCronService = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<PluginHookGatewayCronJob[]>;
  getJob: (id: string) => PluginHookGatewayCronJob | undefined;
  run: (
    id: string,
    mode: "force",
    opts: { evaluateTrigger: true; commitGuard?: () => void },
  ) => Promise<{ ok: boolean; ran?: boolean }>;
  add: (input: PluginHookGatewayCronCreateInput) => Promise<unknown>;
  update: (id: string, patch: PluginHookGatewayCronUpdateInput) => Promise<unknown>;
  mutateTriggerState: (
    id: string,
    mutation: PluginHookGatewayCronTriggerStateMutation,
  ) => Promise<PluginHookGatewayCronJob>;
  remove: (id: string) => Promise<PluginHookGatewayCronRemoveResult>;
  removeStaleJobFamily: (family: {
    declarationKey: string;
    name: string;
    ownerPluginTag: string;
  }) => Promise<number>;
};
