import type { SessionEntry } from "../../config/sessions.js";
import { normalizeAccountId } from "../../utils/account-id.js";
import {
  deliveryContextFromSession,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

function resolveAgentRequesterOriginFromSession(sessionEntry: SessionEntry | undefined) {
  return normalizeDeliveryContext(
    deliveryContextFromSession(sessionEntry) ?? {
      channel: sessionEntry?.lastChannel,
      to: sessionEntry?.lastTo,
      accountId: sessionEntry?.lastAccountId,
      threadId: sessionEntry?.lastThreadId,
    },
  );
}

export function resolveAgentRunContext(
  opts: AgentCommandOpts,
  sessionEntry?: SessionEntry,
): AgentRunContext {
  const merged: AgentRunContext = opts.runContext ? { ...opts.runContext } : {};
  const persistedOrigin = resolveAgentRequesterOriginFromSession(sessionEntry);

  const normalizedChannel = resolveMessageChannel(
    merged.messageChannel ?? opts.messageChannel,
    opts.replyChannel ?? opts.channel ?? persistedOrigin?.channel,
  );
  if (normalizedChannel) {
    merged.messageChannel = normalizedChannel;
  }

  const normalizedAccountId = normalizeAccountId(
    merged.accountId ?? opts.replyAccountId ?? opts.accountId ?? persistedOrigin?.accountId,
  );
  if (normalizedAccountId) {
    merged.accountId = normalizedAccountId;
  }

  const groupId = (merged.groupId ?? opts.groupId)?.toString().trim();
  if (groupId) {
    merged.groupId = groupId;
  }

  const groupChannel = (merged.groupChannel ?? opts.groupChannel)?.toString().trim();
  if (groupChannel) {
    merged.groupChannel = groupChannel;
  }

  const groupSpace = (merged.groupSpace ?? opts.groupSpace)?.toString().trim();
  if (groupSpace) {
    merged.groupSpace = groupSpace;
  }

  if (
    merged.currentThreadTs == null &&
    (opts.threadId ?? persistedOrigin?.threadId) != null &&
    (opts.threadId ?? persistedOrigin?.threadId) !== "" &&
    (opts.threadId ?? persistedOrigin?.threadId) !== null
  ) {
    merged.currentThreadTs = String(opts.threadId ?? persistedOrigin?.threadId);
  }

  // Populate currentChannelId from the outbound target so that
  // resolveTelegramAutoThreadId can match the originating chat.
  const rawCurrentChannelId = opts.replyTo ?? opts.to ?? persistedOrigin?.to;
  if (!merged.currentChannelId && typeof rawCurrentChannelId === "string") {
    const trimmedTo = rawCurrentChannelId.trim();
    if (trimmedTo) {
      merged.currentChannelId = trimmedTo;
    }
  }

  return merged;
}
