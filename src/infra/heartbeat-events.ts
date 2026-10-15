// Deprecated v4 projection of ordinary automation outcomes; no execution state lives here.
import type { CronEvent } from "../cron/service/state.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

type HeartbeatIndicatorType = "ok" | "alert" | "error";

const TARGET_NONE_MESSAGE = "Proactive automation delivery is disabled.";
const NO_ROUTE_MESSAGE =
  "Proactive automation has no delivery route. Configure its delivery in Automations; run openclaw doctor --fix for legacy configuration.";

export type HeartbeatEventPayload = {
  ts: number;
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
  to?: string;
  accountId?: string;
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;
  reason?: string;
  /** Operator-facing companion to the machine-stable reason code. */
  message?: string;
  /** The channel the ordinary automation delivered to. */
  channel?: string;
  /** Whether the outcome produced no visible delivery. */
  silent?: boolean;
  /** Indicator type for UI status display. */
  indicatorType?: HeartbeatIndicatorType;
};

type HeartbeatEventState = {
  lastHeartbeat: HeartbeatEventPayload | null;
  listeners: Set<(evt: HeartbeatEventPayload) => void>;
};

const HEARTBEAT_EVENT_STATE_KEY = Symbol.for("openclaw.heartbeatEvents.state");

const state = resolveGlobalSingleton<HeartbeatEventState>(HEARTBEAT_EVENT_STATE_KEY, () => ({
  lastHeartbeat: null,
  listeners: new Set<(evt: HeartbeatEventPayload) => void>(),
}));

export function emitHeartbeatEvent(evt: Omit<HeartbeatEventPayload, "ts">) {
  const enriched: HeartbeatEventPayload = {
    ts: Date.now(),
    ...evt,
    ...(evt.message === undefined && evt.reason === "target-none"
      ? { message: TARGET_NONE_MESSAGE }
      : evt.message === undefined && evt.reason === "no-route"
        ? { message: NO_ROUTE_MESSAGE }
        : {}),
  };
  state.lastHeartbeat = enriched;
  notifyListeners(state.listeners, enriched);
}

/** Called only for receipt-owned converted/default jobs after canonical settlement. */
export function emitLegacyHeartbeatCronOutcome(evt: CronEvent): void {
  if (evt.action !== "finished") {
    return;
  }
  emitHeartbeatEvent({
    status:
      evt.status === "error" ||
      evt.deliveryError ||
      (evt.completionStatus === "failed" && evt.status !== "skipped")
        ? "failed"
        : evt.status === "skipped" || evt.completionStatus === "unknown"
          ? "skipped"
          : evt.delivered
            ? "sent"
            : "ok-empty",
    preview: evt.summary?.slice(0, 2000),
    reason:
      evt.error ??
      evt.deliveryError ??
      evt.deliverySuppressionReason ??
      (evt.completionStatus === "unknown"
        ? "Automation completion is unknown; inspect its run history."
        : undefined),
    durationMs: evt.durationMs,
    silent: !evt.delivered,
    channel: evt.delivery?.resolved?.channel,
    to: evt.delivery?.resolved?.to ?? undefined,
    accountId: evt.delivery?.resolved?.accountId,
  });
}

export function onHeartbeatEvent(listener: (evt: HeartbeatEventPayload) => void): () => void {
  return registerListener(state.listeners, listener);
}

export function getLastHeartbeatEvent(): HeartbeatEventPayload | null {
  return state.lastHeartbeat;
}

export function resetHeartbeatEventsForTest(): void {
  state.lastHeartbeat = null;
  state.listeners.clear();
}
