import type { SessionMaintenanceWarning } from "../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { formatSingleUnitDuration } from "./format-time/format-duration-internal.js";
import { pruneMapToMaxSize } from "./map-size.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";
import { resolveSystemEventQueueKey } from "./system-event-ownership.js";
import { enqueueSystemEvent } from "./system-events.js";

type WarningParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  entry: SessionEntry;
  warning: SessionMaintenanceWarning;
};

// Bound process-lifetime dedupe. Eviction can re-emit one warning for an old session.
const MAX_WARNED_CONTEXTS = 4096;
const warnedContexts = new Map<string, string>();

function shouldSuppressWarning(sessionKey: string, contextKey: string): boolean {
  const duplicate = warnedContexts.get(sessionKey) === contextKey;
  // Refresh insertion order even for suppressed duplicates; otherwise active sessions
  // become eviction candidates and can receive repeated warnings under key churn.
  warnedContexts.delete(sessionKey);
  warnedContexts.set(sessionKey, contextKey);
  pruneMapToMaxSize(warnedContexts, MAX_WARNED_CONTEXTS);
  return duplicate;
}

const log = createSubsystemLogger("session-maintenance-warning");
const loadDeliverRuntime = createLazyPromiseLoader(() => import("../channels/message/runtime.js"), {
  cacheRejections: true,
}).load;

function buildWarningContext(warning: SessionMaintenanceWarning): string {
  return [
    warning.activeSessionKey,
    warning.pruneAfterMs,
    warning.maxEntries,
    warning.wouldPrune ? "prune" : "",
    warning.wouldCap ? "cap" : "",
    warning.capOutcome ?? "",
    warning.pruneOutcome ?? "",
  ]
    .filter(Boolean)
    .join("|");
}

function buildWarningText(warning: SessionMaintenanceWarning): string {
  const reasons: string[] = [];
  if (warning.wouldPrune) {
    reasons.push(`older than ${formatSingleUnitDuration(warning.pruneAfterMs, true)}`);
  }
  if (warning.wouldCap) {
    reasons.push(`not in the most recent ${warning.maxEntries} sessions`);
  }
  const reasonText = reasons.length > 0 ? reasons.join(" and ") : "over maintenance limits";
  const outcome =
    warning.pruneOutcome === "remove" || warning.capOutcome === "remove" ? "removed" : "archived";
  return (
    `⚠️ Session maintenance warning: this active session would be ${outcome} (${reasonText}). ` +
    `Maintenance is set to warn-only, so nothing was changed. ` +
    `To enforce cleanup, set \`session.maintenance.mode: "enforce"\` or increase the limits.`
  );
}

/** Deliver or enqueue a warn-only session maintenance notification. */
export async function deliverSessionMaintenanceWarning(params: WarningParams): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  const contextKey = buildWarningContext(params.warning);
  const queueKey = resolveSystemEventQueueKey(params.sessionKey, params.agentId);
  // Dedupe by effective warning context so repeated maintenance scans do not
  // spam the same session, but changed limits still produce a fresh warning.
  if (shouldSuppressWarning(queueKey, contextKey)) {
    return;
  }

  const text = buildWarningText(params.warning);
  const target = deliveryContextFromSession(params.entry);
  const channel = target?.channel
    ? (normalizeMessageChannel(target.channel) ?? target.channel)
    : undefined;
  if (!channel || !isDeliverableMessageChannel(channel) || !target?.to) {
    enqueueSystemEvent(text, { sessionKey: queueKey });
    return;
  }

  try {
    const { sendDurableMessageBatchCore } = await loadDeliverRuntime();
    const outboundSession = buildOutboundSessionContext({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    const send = await sendDurableMessageBatchCore({
      cfg: params.cfg,
      channel,
      to: target.to,
      accountId: target.accountId,
      threadId: target.threadId,
      payloads: [{ text }],
      session: outboundSession,
    });
    if (send.status === "failed" || send.status === "partial_failed") {
      throw send.error;
    }
  } catch (err) {
    log.warn(`Failed to deliver session maintenance warning: ${String(err)}`);
    enqueueSystemEvent(text, { sessionKey: queueKey });
  }
}
