import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CronEvent } from "../cron/types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners } from "../shared/listeners.js";

type HeartbeatIndicatorType = "ok" | "alert" | "error";

const TARGET_NONE_MESSAGE = "Heartbeat delivery is disabled by configuration (target: none).";
const NO_ROUTE_MESSAGE =
  "Heartbeat has no delivery route yet. Message your bot once, or set agents.defaults.heartbeat.target.";

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
  /** The channel this heartbeat was sent to. */
  channel?: string;
  /** Whether the message was silently suppressed (showOk: false). */
  silent?: boolean;
  /** Indicator type for UI status display. */
  indicatorType?: HeartbeatIndicatorType;
};

type HeartbeatEventState = {
  lastHeartbeat: HeartbeatEventPayload | null;
  notifications: { onEvent: (evt: HeartbeatEventPayload) => void };
};

const HEARTBEAT_EVENT_STATE_KEY = Symbol.for("openclaw.heartbeatEvents.state");

const state = resolveGlobalSingleton<HeartbeatEventState>(HEARTBEAT_EVENT_STATE_KEY, () => ({
  lastHeartbeat: null,
  notifications: { onEvent: () => {} },
}));

export const heartbeatNotifications = state.notifications;

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
  notifyListeners([state.notifications.onEvent], enriched);
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
    preview: evt.summary === undefined ? undefined : truncateUtf16Safe(evt.summary, 2000),
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

export function getLastHeartbeatEvent(): HeartbeatEventPayload | null {
  return state.lastHeartbeat;
}

export function resetHeartbeatEventsForTest(): void {
  state.lastHeartbeat = null;
  state.notifications.onEvent = () => {};
}
