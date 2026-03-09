import { isEmbeddedPiRunActive } from "../agents/pi-embedded-runner/runs.js";
import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { CliDeps } from "../cli/deps.js";
import { parseSessionThreadInfo } from "../config/sessions/delivery-info.js";
import { loadActiveTurnMarkers, removeActiveTurnMarker } from "../infra/active-turns.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { deliveryContextFromSession, mergeDeliveryContext } from "../utils/delivery-context.js";
import { loadSessionEntry } from "./session-utils.js";

const log = createSubsystemLogger("active-turn-recovery");

const RECOVERY_MESSAGE =
  "I was interrupted while processing your message. Could you please resend your last message?";

/**
 * On gateway startup, check for active turn markers left behind by a
 * previous crash or unclean restart. For each stale marker, deliver a
 * notification to the user so they know to resend their message.
 *
 * Follows the same delivery resolution chain as
 * {@link scheduleRestartSentinelWake} in `server-restart-sentinel.ts`.
 */
export async function recoverInterruptedTurns(_params: { deps: CliDeps }): Promise<number> {
  const markers = await loadActiveTurnMarkers();
  if (markers.length === 0) {
    return 0;
  }

  log.info(`found ${markers.length} interrupted turn(s) — starting recovery`);

  let recovered = 0;
  for (const marker of markers) {
    // Skip markers for runs that are currently active — a message received
    // during the startup delay may have already created a live run. Removing
    // its marker would make the active turn invisible to crash recovery and
    // the stuck-turn watchdog.
    if (isEmbeddedPiRunActive(marker.sessionId)) {
      log.info(`skipping live run: sessionId=${marker.sessionId}`);
      continue;
    }

    // Always clear the marker first (consume-then-process pattern) to prevent
    // infinite retry loops if the gateway crashes again during recovery.
    await removeActiveTurnMarker(marker.sessionId);

    try {
      await deliverRecoveryNotification(marker.sessionKey);
      recovered += 1;
      log.info(`recovered interrupted turn: sessionKey=${marker.sessionKey}`);
    } catch (err) {
      log.warn(
        `failed to deliver recovery notification: sessionKey=${marker.sessionKey} err=${String(err)}`,
      );
    }
  }

  log.info(`active turn recovery complete: ${recovered}/${markers.length} recovered`);
  return recovered;
}

async function deliverRecoveryNotification(sessionKey: string): Promise<void> {
  const { baseSessionKey, threadId: sessionThreadId } = parseSessionThreadInfo(sessionKey);

  const { cfg, entry } = loadSessionEntry(sessionKey);
  const parsedTarget = resolveAnnounceTargetFromKey(baseSessionKey ?? sessionKey);

  let sessionDeliveryContext = deliveryContextFromSession(entry);
  if (!sessionDeliveryContext && baseSessionKey && baseSessionKey !== sessionKey) {
    const { entry: baseEntry } = loadSessionEntry(baseSessionKey);
    sessionDeliveryContext = deliveryContextFromSession(baseEntry);
  }

  const origin = mergeDeliveryContext(sessionDeliveryContext, parsedTarget ?? undefined);

  const channelRaw = origin?.channel;
  const channel = channelRaw ? normalizeChannelId(channelRaw) : null;
  const to = origin?.to;
  if (!channel || !to) {
    enqueueSystemEvent(RECOVERY_MESSAGE, { sessionKey });
    return;
  }

  const resolved = resolveOutboundTarget({
    channel,
    to,
    cfg,
    accountId: origin?.accountId,
    mode: "implicit",
  });
  if (!resolved.ok) {
    enqueueSystemEvent(RECOVERY_MESSAGE, { sessionKey });
    return;
  }

  const threadId =
    parsedTarget?.threadId ??
    sessionThreadId ??
    (origin?.threadId != null ? String(origin.threadId) : undefined);

  // Slack uses replyToId (thread_ts) for threading, not threadId.
  const isSlack = channel === "slack";
  const replyToId = isSlack && threadId != null && threadId !== "" ? String(threadId) : undefined;
  const resolvedThreadId = isSlack ? undefined : threadId;

  const outboundSession = buildOutboundSessionContext({ cfg, sessionKey });

  try {
    await deliverOutboundPayloads({
      cfg,
      channel,
      to: resolved.to,
      accountId: origin?.accountId,
      replyToId,
      threadId: resolvedThreadId,
      payloads: [{ text: RECOVERY_MESSAGE }],
      session: outboundSession,
      bestEffort: true,
    });
  } catch (err) {
    enqueueSystemEvent(`Active turn recovery failed: ${String(err)}`, { sessionKey });
  }
}
