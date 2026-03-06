import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { CliDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { parseSessionThreadInfo } from "../config/sessions/delivery-info.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import {
  consumeRestartSentinel,
  formatRestartSentinelMessage,
  type RestartSentinelPayload,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { defaultRuntime } from "../runtime.js";
import { deliveryContextFromSession, mergeDeliveryContext } from "../utils/delivery-context.js";
import { loadSessionEntry } from "./session-utils.js";

function buildRestartContinuationRequest(params: {
  payload: RestartSentinelPayload;
  sessionKey: string;
  channel?: string | null;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}) {
  const prompt =
    params.payload.continuation?.kind === "agent-turn"
      ? params.payload.continuation.prompt.trim()
      : "";
  if (!prompt) {
    return null;
  }
  const hasDeliveryTarget = Boolean(params.channel && params.to);
  const runContext = {
    ...(params.channel ? { messageChannel: params.channel } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.to ? { currentChannelId: params.to } : {}),
    ...(params.threadId != null && params.threadId !== ""
      ? { currentThreadTs: String(params.threadId) }
      : {}),
  };
  return {
    message: prompt,
    sessionKey: params.sessionKey,
    ...(hasDeliveryTarget
      ? {
          deliver: true,
          channel: params.channel,
          to: params.to,
          deliveryTargetMode: "explicit" as const,
        }
      : {}),
    ...(params.channel ? { messageChannel: params.channel } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.threadId != null && params.threadId !== ""
      ? { threadId: String(params.threadId) }
      : {}),
    ...(Object.keys(runContext).length > 0 ? { runContext } : {}),
    bestEffortDeliver: true,
    inputProvenance: {
      kind: "internal_system" as const,
      ...(params.channel ? { sourceChannel: params.channel } : {}),
      sourceTool: "gateway.restart.continuation",
    },
    senderIsOwner: true,
  };
}

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
  let continuationTo = to;
  if (!channel || !to) {
    enqueueSystemEvent(message, { sessionKey });
  } else {
    const resolved = resolveOutboundTarget({
      channel,
      to,
      cfg,
      accountId: origin?.accountId,
      mode: "implicit",
    });
    if (!resolved.ok) {
      continuationTo = undefined;
      enqueueSystemEvent(message, { sessionKey });
    } else {
      continuationTo = resolved.to;
    }
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

  if (channel && continuationTo) {
    try {
      await deliverOutboundPayloads({
        cfg,
        channel,
        to: continuationTo,
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
  }

  const continuationRequest = buildRestartContinuationRequest({
    payload,
    sessionKey,
    channel,
    to: continuationTo,
    accountId: origin?.accountId,
    threadId,
  });
  if (!continuationRequest) {
    return;
  }

  void agentCommandFromIngress(continuationRequest, defaultRuntime, _params.deps).catch((err) => {
    enqueueSystemEvent(`Restart continuation failed: ${String(err)}`, { sessionKey });
  });
}

export function shouldWakeFromRestartSentinel() {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}
