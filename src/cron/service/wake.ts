import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
/** Manual cron wake helper for queueing system events into sessions. */
import { isSubagentSessionKey, normalizeOptionalAgentId } from "../../routing/session-key.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import {
  resolveCronNotificationQueueOwner,
  type CronNotificationJob,
  type CronNotificationRouting,
} from "./notification-intents.js";
import type { CronServiceState } from "./state.js";

/** Keeps safety notices with their creator and limits failure routes to explicit origins. */
export function enqueueCronNotification(
  state: CronServiceState,
  job: CronNotificationJob,
  text: string,
  kind: "auto-disabled" | "failure-alert",
  routing: CronNotificationRouting,
): void {
  const owner = resolveCronNotificationQueueOwner(job, kind);
  const { sessionKey } = owner;
  const agentId = owner.agentId ?? normalizeOptionalAgentId(routing.defaultAgentId);
  if (!agentId) {
    throw new Error(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
  }
  const deliveryContext =
    sessionKey || (kind === "auto-disabled" && agentId)
      ? state.deps.resolveOriginDeliveryContext?.({ agentId, sessionKey })
      : undefined;
  if (!state.deps.enqueueSessionEvent) {
    throw new Error("Session event execution is unavailable; restart the Gateway and retry");
  }
  state.deps.enqueueSessionEvent(text, {
    agentId,
    sessionKey,
    contextKey: `cron:${job.id}:${kind}`,
    ...(deliveryContext ? { deliveryContext } : {}),
  });
}

/** The v4 wake adapter targets ordinary immediate or explicitly scheduled session work. */
export function wake(
  state: CronServiceState,
  opts: {
    mode: "now" | "next-heartbeat";
    expectedTarget?: SessionEventTarget;
    text: string;
    /**
     * Internal session key to enqueue the system event against. When omitted,
     * the dep resolves the configured system-agent target — wakes from a non-main
     * session would otherwise route to the wrong place. Callers wiring an
     * agent-tool `wake` should thread the resolved session key (e.g. from
     * `cron-tool`'s `resolveInternalSessionKey`) so the event lands on the
     * originating conversation lane.
     */
    sessionKey?: string;
    /** The agent that owns the targeted conversation, independent of the ambient default. */
    agentId?: string;
  },
) {
  const text = opts.text.trim();
  if (!text) {
    return { ok: false } as const;
  }
  const sessionKey = opts.sessionKey?.trim() || undefined;
  const agentId = opts.agentId?.trim() || undefined;
  if (sessionKey && isSubagentSessionKey(sessionKey)) {
    return { ok: false, reason: "unwakeable-session-key" } as const;
  }
  // Carry the originating session's channel-correct delivery context (e.g. the
  // bound Telegram topic/thread) so a wake routes back into that thread instead
  // of the chat root. Only attempt this when an origin session is targeted; a
  // No-origin wakes keeps the empty option shape so the Gateway adapter can
  // resolve the current system-agent owner and session atomically.
  const originDeliveryContext =
    opts.expectedTarget?.deliveryContext ??
    (sessionKey || agentId
      ? state.deps.resolveOriginDeliveryContext?.({ sessionKey, agentId })
      : undefined);
  const enqueueOpts =
    sessionKey || agentId
      ? {
          ...(opts.expectedTarget ? { expectedTarget: opts.expectedTarget } : {}),
          ...(sessionKey ? { sessionKey } : {}),
          ...(agentId ? { agentId } : {}),
          ...(originDeliveryContext ? { deliveryContext: originDeliveryContext } : {}),
        }
      : undefined;
  if (opts.mode === "now" || sessionKey) {
    if (!state.deps.enqueueSessionEvent) {
      return {
        ok: false,
        reason: "Session event execution is unavailable; restart the Gateway",
      } as const;
    }
    state.deps.enqueueSessionEvent(text, enqueueOpts);
    return { ok: true } as const;
  }
  const target = state.deps.resolveSessionEventTarget?.({ agentId });
  const job = state.store?.jobs.find((candidate) => {
    if (
      !target?.agentId ||
      !target.sessionKey ||
      !candidate.enabled ||
      candidate.state.autoDisabled ||
      !["agentTurn", "systemEvent"].includes(candidate.payload.kind) ||
      !(candidate.sessionTarget === "main" || candidate.sessionTarget.startsWith("session:")) ||
      !Number.isFinite(candidate.state.nextRunAtMs)
    ) {
      return false;
    }
    const jobTarget = state.deps.resolveSessionEventTarget?.({
      agentId: candidate.agentId,
      sessionKey: candidate.sessionTarget.startsWith("session:")
        ? candidate.sessionTarget.slice(8)
        : undefined,
    });
    return jobTarget?.agentId === target.agentId && jobTarget.sessionKey === target.sessionKey;
  });
  if (!state.deps.cronEnabled || state.stopped || !job || !state.deps.deferSessionEvent) {
    return {
      ok: false,
      reason:
        "No enabled ordinary scheduled session job can receive this wake. Choose mode now or create an automation with a scheduled session turn.",
    } as const;
  }
  state.deps.deferSessionEvent(text, job, opts.expectedTarget);
  return { ok: true } as const;
}
