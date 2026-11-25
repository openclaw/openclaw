import crypto from "node:crypto";
import {
  getChannelPlugin,
  normalizeChannelId as normalizeAnyChannelId,
} from "../../channels/plugins/index.js";
import { resolveSessionConversationRef } from "../../channels/plugins/session-conversation.js";
import { normalizeChatChannelId } from "../../channels/registry.js";
import { parseSessionDeliveryRoute } from "../../sessions/session-key-utils.js";
import { sanitizeAgentRunTerminalReply } from "../agent-run-terminal-reply.js";
import { readLatestAssistantReply, type AgentWaitResult } from "../run-wait.js";
import { jsonResult } from "./tool-results.js";

export const SESSIONS_SEND_TRUNCATION_NOTE =
  "The reply may be truncated. Ask the target for the missing section or a file containing the full reply; do not repeat the original task.";

export type SessionDeliveryTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string; // Forum topic/thread ID
};

export function sendFailure(
  status: "error" | "forbidden",
  error: string,
  sessionKey?: string,
  runId: string = crypto.randomUUID(),
) {
  return jsonResult({
    runId,
    status,
    error,
    ...(sessionKey !== undefined ? { sessionKey } : {}),
  });
}

export function sendReplyResult(
  receipt: { runId: string; sessionKey: string; watched?: boolean },
  result: { replyText?: string; replyTruncated?: true; sourceReplyDelivered?: boolean },
) {
  const { replyText: reply, replyTruncated, sourceReplyDelivered } = result;
  if (!reply) {
    return jsonResult({
      ...receipt,
      status: "no_reply" as const,
      message: sourceReplyDelivered
        ? "The target delivered its final reply directly to its source conversation. Do not resend."
        : "No visible reply or pending delivery. Continue or retry if needed.",
    });
  }
  return jsonResult({
    ...receipt,
    status: "ok" as const,
    delivery: { status: "skipped" as const },
    ...(replyTruncated
      ? {
          replyTruncated,
          note: SESSIONS_SEND_TRUNCATION_NOTE,
        }
      : {}),
    reply,
  });
}

/** Recover the accepted run's answer under the caller's current history access. */
export async function resolveSessionsSendReply(
  result: AgentWaitResult & { replyText?: string },
  params: Parameters<typeof readLatestAssistantReply>[0],
): Promise<{ replyText?: string; replyTruncated?: true }> {
  const { replyText } = result;
  // A producer-owned full reply can itself end with an ellipsis.
  if (
    !replyText?.endsWith("…") ||
    (result.terminalReply?.disposition === "visible" && result.terminalReply.text !== replyText)
  ) {
    return { replyText };
  }
  const stored = await readLatestAssistantReply(params).catch(() => undefined);
  const snapshot = stored === undefined ? undefined : sanitizeAgentRunTerminalReply(stored);
  return snapshot?.disposition === "visible" && snapshot.text === replyText
    ? { replyText: stored }
    : { replyText, replyTruncated: true };
}

export function resolveSessionDeliveryTargetFromKey(
  sessionKey: string,
): SessionDeliveryTarget | null {
  const parsed = resolveSessionConversationRef(sessionKey);
  if (!parsed) {
    const directRoute = parseSessionDeliveryRoute(sessionKey);
    if (!directRoute || (directRoute.peerKind !== "direct" && directRoute.peerKind !== "dm")) {
      return null;
    }

    const normalizedChannel =
      normalizeAnyChannelId(directRoute.channel) ?? normalizeChatChannelId(directRoute.channel);
    const channel = normalizedChannel ?? directRoute.channel;
    const messaging = normalizedChannel
      ? getChannelPlugin(normalizedChannel)?.messaging
      : undefined;
    // Session peers are canonical; adapters restore API casing at their boundary.
    // Channel-style resolvers must not turn an explicit direct user into a room.
    const resolvedTarget =
      messaging?.directTargetStyle === "user-prefixed"
        ? undefined
        : messaging?.resolveDeliveryTarget?.({ conversationId: directRoute.peerId });
    const directTarget = `user:${directRoute.peerId}`;

    return {
      channel,
      to: resolvedTarget?.to?.trim() || messaging?.normalizeTarget?.(directTarget) || directTarget,
      ...(directRoute.accountId ? { accountId: directRoute.accountId } : {}),
      threadId: resolvedTarget?.threadId ?? directRoute.threadId,
    };
  }
  const normalizedChannel =
    normalizeAnyChannelId(parsed.channel) ?? normalizeChatChannelId(parsed.channel);
  const channel = normalizedChannel ?? parsed.channel;
  const plugin = normalizedChannel ? getChannelPlugin(normalizedChannel) : null;
  const genericTarget = parsed.kind === "channel" ? `channel:${parsed.id}` : `group:${parsed.id}`;
  // Prefer plugin-owned target normalization so channel-specific IDs and topics survive routing.
  const normalized =
    plugin?.messaging?.resolveSessionTarget?.({
      kind: parsed.kind,
      id: parsed.id,
      threadId: parsed.threadId,
    }) ?? plugin?.messaging?.normalizeTarget?.(genericTarget);
  return {
    channel,
    to: normalized ?? (normalizedChannel ? genericTarget : parsed.id),
    threadId: parsed.threadId,
  };
}
