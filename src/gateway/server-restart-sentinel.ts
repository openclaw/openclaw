import { listAgentIds } from "../agents/agent-scope.js";
import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { CliDeps } from "../cli/deps.js";
import { loadConfig } from "../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { parseSessionThreadInfo } from "../config/sessions/delivery-info.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import {
  consumeRestartSentinel,
  formatRestartSentinelMessage,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { deliveryContextFromSession, mergeDeliveryContext } from "../utils/delivery-context.js";
import { loadSessionEntry } from "./session-utils.js";

export async function scheduleRestartSentinelWake(_params: { deps: CliDeps }) {
  const sentinel = await consumeRestartSentinel();
  if (!sentinel) {
    return;
  }
  const payload = sentinel.payload;
  const sessionKey = payload.sessionKey?.trim();
  const message = formatRestartSentinelMessage(payload);
  const summary = summarizeRestartSentinel(payload);

  if (!sessionKey) {
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(message, { sessionKey: mainSessionKey });
    wakeRecentlyActiveSessions(message, mainSessionKey, payload.ts);
    return;
  }

  const { baseSessionKey, threadId: sessionThreadId } = parseSessionThreadInfo(sessionKey);

  const { cfg, entry } = loadSessionEntry(sessionKey);
  const parsedTarget = resolveAnnounceTargetFromKey(baseSessionKey ?? sessionKey);

  // Prefer delivery context from sentinel (captured at restart) over session store
  // Handles race condition where store wasn't flushed before restart
  const sentinelContext = payload.deliveryContext;
  let sessionDeliveryContext = deliveryContextFromSession(entry);
  if (!sessionDeliveryContext && baseSessionKey && baseSessionKey !== sessionKey) {
    const { entry: baseEntry } = loadSessionEntry(baseSessionKey);
    sessionDeliveryContext = deliveryContextFromSession(baseEntry);
  }

  const origin = mergeDeliveryContext(
    sentinelContext,
    mergeDeliveryContext(sessionDeliveryContext, parsedTarget ?? undefined),
  );

  const channelRaw = origin?.channel;
  const channel = channelRaw ? normalizeChannelId(channelRaw) : null;
  const to = origin?.to;
  if (!channel || !to) {
    enqueueSystemEvent(message, { sessionKey });
    wakeRecentlyActiveSessions(message, sessionKey, payload.ts);
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
    enqueueSystemEvent(message, { sessionKey });
    wakeRecentlyActiveSessions(message, sessionKey, payload.ts);
    return;
  }

  const threadId =
    payload.threadId ??
    parsedTarget?.threadId ?? // From resolveAnnounceTargetFromKey (extracts :topic:N)
    sessionThreadId ??
    (origin?.threadId != null ? String(origin.threadId) : undefined);

  // Slack uses replyToId (thread_ts) for threading, not threadId.
  // The reply path does this mapping but deliverOutboundPayloads does not,
  // so we must convert here to ensure post-restart notifications land in
  // the originating Slack thread. See #17716.
  const isSlack = channel === "slack";
  const replyToId = isSlack && threadId != null && threadId !== "" ? String(threadId) : undefined;
  const resolvedThreadId = isSlack ? undefined : threadId;
  const outboundSession = buildOutboundSessionContext({
    cfg,
    sessionKey,
  });

  try {
    await deliverOutboundPayloads({
      cfg,
      channel,
      to: resolved.to,
      accountId: origin?.accountId,
      replyToId,
      threadId: resolvedThreadId,
      payloads: [{ text: message }],
      session: outboundSession,
      bestEffort: true,
    });
  } catch (err) {
    enqueueSystemEvent(`${summary}\n${String(err)}`, { sessionKey });
  }

  // Inject a system event into all recently active agent sessions so they
  // can resume interrupted work.  The outbound delivery above notifies the
  // *human* on the triggering session's channel; this notifies *agents*.
  // Without it agents go silent after restarts until someone messages them,
  // even though AGENTS.md tells them to read active-tasks.md and resume
  // autonomously on GatewayRestart.
  wakeRecentlyActiveSessions(message, sessionKey, payload.ts);
}

/**
 * Inject a GatewayRestart system event into sessions that were likely
 * mid-turn when the restart happened.  Uses a 60-second window before
 * the sentinel timestamp: any session whose lastActiveMs falls within
 * that window was probably processing a request when interrupted.
 *
 * The triggering session is always included regardless of timing.
 */
function wakeRecentlyActiveSessions(
  message: string,
  triggeringSessionKey: string,
  restartTimestamp: number,
) {
  const ACTIVE_WINDOW_MS = 60 * 1000; // 60 seconds before restart
  const cutoff = restartTimestamp - ACTIVE_WINDOW_MS;
  const notified = new Set<string>();

  // Always notify the triggering session
  enqueueSystemEvent(message, { sessionKey: triggeringSessionKey });
  notified.add(triggeringSessionKey);

  try {
    const cfg = loadConfig();
    const agentIds = listAgentIds(cfg);
    const storeCfg = cfg.session?.store;

    for (const agentId of agentIds) {
      const storePath = resolveStorePath(storeCfg, { agentId });
      let store: Record<string, { lastActiveMs?: number }>;
      try {
        store = loadSessionStore(storePath) as Record<string, { lastActiveMs?: number }>;
      } catch {
        continue; // Store file missing or corrupt — skip this agent
      }

      for (const [key, entry] of Object.entries(store)) {
        if (notified.has(key)) {
          continue;
        }
        if (isCronRunSessionKey(key)) {
          continue;
        }
        if (key === "global" || key === "unknown") {
          continue;
        }

        // Wake sessions active within 60s before the restart — they were
        // likely mid-turn when the process went down.
        const lastActive = entry?.lastActiveMs ?? 0;
        if (lastActive >= cutoff && lastActive <= restartTimestamp) {
          enqueueSystemEvent(message, { sessionKey: key });
          notified.add(key);
        }
      }
    }
  } catch {
    // Config or store enumeration failed — at minimum the triggering
    // session was already notified above, so this is best-effort.
  }
}

export function shouldWakeFromRestartSentinel() {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}
