export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string; retryAtMs?: number }
  | { status: "failed"; reason: string };

export type HeartbeatWakeIntent = "scheduled" | "task" | "event" | "immediate" | "manual";

export type HeartbeatWakeSource =
  | "interval"
  | "manual"
  | "exec-event"
  | "notifications-event"
  | "cron"
  | "hook"
  | "background-task"
  | "background-task-blocked"
  | "acp-spawn"
  | "session-state"
  | "cli-watchdog"
  | "restart-sentinel"
  | "retry"
  | "other";

export type HeartbeatWakeOverride = {
  target?: string;
  to?: string | undefined;
  accountId?: string | undefined;
};

/** Cron-owned periodic work carried directly into a guarded heartbeat turn. */
export type HeartbeatScheduledTask = {
  jobId: string;
  name: string;
  prompt: string;
};

export type HeartbeatWakeRequest = {
  source: HeartbeatWakeSource;
  intent: HeartbeatWakeIntent;
  reason?: string;
  agentId?: string;
  sessionKey?: string;
  /** Continuation lineage carried from the requesting run into the woken turn. */
  parentRunId?: string;
  heartbeat?: HeartbeatWakeOverride;
  /** Persisted cron monitor cadence carried with a scheduled heartbeat tick. */
  scheduledEveryMs?: number;
  /** Original persisted monitor anchor retained across direct retry handoff. */
  scheduledAnchorMs?: number;
  tasks?: readonly HeartbeatScheduledTask[];
  /** Internal marker for work retained after a spacing/cooldown deferral. */
  retainedWork?: boolean;
};

export type HeartbeatWakeHandler = (opts: HeartbeatWakeRequest) => Promise<HeartbeatRunResult>;

const TRUSTED_CONTINUATION_ROUTING_MARKER = Symbol.for(
  "openclaw.heartbeat.trusted-continuation-routing",
);

export function markTrustedContinuationHeartbeatWake<T extends object>(request: T): T {
  Object.defineProperty(request, TRUSTED_CONTINUATION_ROUTING_MARKER, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return request;
}

export function hasTrustedContinuationHeartbeatWake(request: unknown): boolean {
  return Boolean(
    request &&
    typeof request === "object" &&
    Reflect.get(request, TRUSTED_CONTINUATION_ROUTING_MARKER) === true,
  );
}
