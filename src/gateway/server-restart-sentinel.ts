import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { CliDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { parseSessionThreadInfo } from "../config/sessions/delivery-info.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import {
  consumeRestartSentinel,
  formatRestartSentinelInternalContext,
  formatRestartSentinelMessage,
  formatRestartSentinelUserMessage,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { defaultRuntime } from "../runtime.js";
import { deliveryContextFromSession, mergeDeliveryContext } from "../utils/delivery-context.js";
import { loadSessionEntry } from "./session-utils.js";

export async function scheduleRestartSentinelWake(params: { deps: CliDeps }) {
  const sentinel = await consumeRestartSentinel();
  if (!sentinel) {
    return;
  }
  const payload = sentinel.payload;
  const sessionKey = payload.sessionKey?.trim();
  // Raw diagnostic message (used for system events and enqueue fallbacks).
  const message = formatRestartSentinelMessage(payload);
  // Human-friendly message for direct user delivery — omits status prefix and doctorHint.
  const userMessage = formatRestartSentinelUserMessage(payload);
  // Full technical context injected into the agent's system prompt.
  const internalContext = formatRestartSentinelInternalContext(payload);
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
  if (!channel || !to) {
    enqueueSystemEvent(userMessage, { sessionKey });
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
    enqueueSystemEvent(userMessage, { sessionKey });
    return;
  }

  const threadId =
    payload.threadId ??
    parsedTarget?.threadId ?? // From resolveAnnounceTargetFromKey (extracts :topic:N)
    sessionThreadId ??
    (origin?.threadId != null ? String(origin.threadId) : undefined);

  // Step 1: deliver a human-friendly restart notice deterministically — model-independent,
  // guaranteed. Uses userMessage (omits raw diagnostic fields like status prefix and
  // doctorHint) so the user sees a clean message even if the agent turn in Step 2 fails.
  // Slack uses replyToId (thread_ts) for threading; deliverOutboundPayloads does not do
  // this mapping automatically, so we convert here. See #17716.
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
      payloads: [{ text: userMessage }],
      session: outboundSession,
      bestEffort: true,
    });
  } catch {
    // bestEffort: true means this should not throw, but guard anyway.
    // If it does throw (channel plugin/runtime error before best-effort handling is applied),
    // enqueue a system event so the user receives the restart notice even on delivery failure.
    // This preserves the prior behaviour where delivery errors in this path produced a fallback event.
    enqueueSystemEvent(userMessage, { sessionKey });
  }

  // Step 2: trigger an agent resume turn so the agent can continue autonomously
  // after restart. The model sees the restart context and can respond/take actions.
  // internalContext is injected via extraSystemPrompt so the agent has full technical
  // details (kind, status, note, doctorHint) without exposing raw diagnostics as a
  // user-visible chat message. The agent's reply is what the user ultimately sees.
  // This is safe post-restart: scheduleRestartSentinelWake() runs in the new process
  // with zero in-flight replies, so the pre-restart race condition (ab4a08a82) does
  // not apply here.
  try {
    await agentCommand(
      {
        message: userMessage,
        extraSystemPrompt: internalContext,
        sessionKey,
        to: resolved.to,
        channel,
        deliver: true,
        bestEffortDeliver: true,
        messageChannel: channel,
        threadId,
        accountId: origin?.accountId,
      },
      defaultRuntime,
      params.deps,
    );
  } catch (err) {
    enqueueSystemEvent(`${summary}\n${String(err)}`, { sessionKey });
  }
}

export function shouldWakeFromRestartSentinel() {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}
