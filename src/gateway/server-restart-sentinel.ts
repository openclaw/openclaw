import { resolveAnnounceTargetFromKey } from "../agents/tools/sessions-send-helpers.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { CliDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { parseSessionThreadInfo } from "../config/sessions/delivery-info.js";
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

  // Trigger an agent resume turn so the agent can compose a natural response and
  // continue autonomously after restart. The restart context is injected via
  // extraSystemPrompt — the raw note, doctorHint, and status fields are NEVER
  // sent directly to the channel. Only the agent's composed reply reaches the user.
  //
  // summary is used as the neutral wake prompt (e.g. "Gateway restart config-patch ok").
  // It is an internal technical label; the agent sees it but users do not — only the
  // agent's response is delivered.
  //
  // This is safe post-restart: scheduleRestartSentinelWake() runs in the new process
  // with zero in-flight replies, so the pre-restart race condition (ab4a08a82) does
  // not apply here.
  //
  // Explicitly set senderIsOwner: false. The restart wake runs in a new process after
  // an operator-triggered restart, and we cannot reliably infer the original sender's
  // authorization level. Defaulting to false prevents privilege escalation where any
  // restarted session would inherit owner-level access. See #18612.
  try {
    await agentCommand(
      {
        message: summary,
        extraSystemPrompt: internalContext,
        sessionKey,
        to: resolved.to,
        channel,
        deliver: true,
        bestEffortDeliver: true,
        messageChannel: channel,
        threadId,
        accountId: origin?.accountId,
        senderIsOwner: false,
      },
      defaultRuntime,
      params.deps,
    );
  } catch (err) {
    // Agent failed — fall back to a clean restart notice without raw sentinel fields
    // so the user isn't left completely silent after a restart.
    enqueueSystemEvent(`${summary}\n${String(err)}`, { sessionKey });
  }
}

export function shouldWakeFromRestartSentinel() {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}
