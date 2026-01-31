/**
 * Feishu Message Dispatch
 *
 * Routes incoming Feishu messages through the agent dispatch system,
 * similar to how Telegram messages are handled.
 */

import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { getStartupChatIds, type ResolvedFeishuAccount } from "./accounts.js";
import type { FeishuMessageContext } from "./monitor.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { dispatchInboundMessageWithBufferedDispatcher } from "../auto-reply/dispatch.js";
import { formatInboundEnvelope, resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { normalizeCommandBody } from "../auto-reply/commands-registry.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../config/group-policy.js";
import { danger } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { createDedupeCache } from "../infra/dedupe.js";
import { formatUncaughtError } from "../infra/errors.js";
import { loadWebMedia } from "../web/media.js";
import { sendMediaFeishu, sendMessageFeishu } from "./send.js";
import { downloadFeishuInboundMedia, type FeishuInboundMedia } from "./download.js";

// Message deduplication cache to prevent processing duplicate messages
const feishuMessageDedupe = createDedupeCache({
  maxSize: 1000,
  ttlMs: 60_000, // 1 minute
});

const MB = 1024 * 1024;

export type DispatchFeishuMessageParams = {
  ctx: FeishuMessageContext;
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  account: ResolvedFeishuAccount;
};

/**
 * Build peer ID for Feishu (group may include thread)
 */
function buildFeishuPeerId(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}:${threadId}` : chatId;
}

/**
 * Check if sender is allowed based on config
 */
function isFeishuSenderAllowed(
  ctx: FeishuMessageContext,
  cfg: OpenClawConfig,
  account: ResolvedFeishuAccount,
): { allowed: boolean; reason?: string } {
  const isGroup = ctx.chatType === "group";
  const senderId = ctx.senderId;

  // When allowOnlyStartupChats is true: only groups in startupChatId may send; no DMs
  if (account.config.allowOnlyStartupChats) {
    const allowedChatIds = getStartupChatIds(account.config);
    if (allowedChatIds.length === 0) {
      return { allowed: false, reason: "allow_only_startup_chats_no_list" };
    }
    if (!isGroup) {
      return { allowed: false, reason: "allow_only_startup_chats_no_dm" };
    }
    if (!allowedChatIds.includes(ctx.chatId)) {
      return { allowed: false, reason: "allow_only_startup_chats_group_not_allowed" };
    }
    return { allowed: true };
  }

  if (isGroup) {
    // Check group policy
    const groupPolicySetting = account.config.groupPolicy ?? "open";
    if (groupPolicySetting === "disabled") {
      return { allowed: false, reason: "group_disabled" };
    }

    const groupPolicy = resolveChannelGroupPolicy({
      cfg,
      channel: "feishu",
      accountId: account.accountId,
      groupId: ctx.chatId,
    });

    if (groupPolicy.allowlistEnabled && !groupPolicy.allowed) {
      return { allowed: false, reason: "group_not_in_allowlist" };
    }

    // Check groupAllowFrom for sender filtering
    const groupAllowFrom = account.config.groupAllowFrom ?? [];
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { allowed: false, reason: "sender_not_in_group_allowlist" };
    }
  } else {
    // DM policy
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    if (dmPolicy === "disabled") {
      return { allowed: false, reason: "dm_disabled" };
    }

    if (dmPolicy === "allowlist") {
      const allowFrom = account.config.allowFrom ?? [];
      if (allowFrom.length > 0 && !allowFrom.includes(senderId)) {
        return { allowed: false, reason: "sender_not_in_allowlist" };
      }
    }

    // TODO: Handle pairing mode for unknown DMs
    // For now, allow through if not explicitly blocked
  }

  return { allowed: true };
}

/**
 * Check if mention is required in group chats
 */
function requiresFeishuMention(
  ctx: FeishuMessageContext,
  cfg: OpenClawConfig,
  account: ResolvedFeishuAccount,
): boolean {
  if (ctx.chatType !== "group") return false;

  return resolveChannelGroupRequireMention({
    cfg,
    channel: "feishu",
    accountId: account.accountId,
    groupId: ctx.chatId,
  });
}

/**
 * Resolve prompt suffix for the given context.
 * Group-level promptSuffix takes precedence over account-level.
 */
function resolvePromptSuffix(
  ctx: FeishuMessageContext,
  account: ResolvedFeishuAccount,
): string | undefined {
  // Check group-level override first
  if (ctx.chatType === "group") {
    const groupConfig = account.config.groups?.[ctx.chatId];
    if (groupConfig?.promptSuffix?.trim()) {
      return groupConfig.promptSuffix.trim();
    }
  }
  // Fall back to account-level
  return account.config.promptSuffix?.trim() || undefined;
}

async function resolveInboundMedia(params: {
  ctx: FeishuMessageContext;
  cfg: OpenClawConfig;
  account: ResolvedFeishuAccount;
}): Promise<FeishuInboundMedia | null> {
  const { ctx, cfg, account } = params;

  const maxMb = account.config.mediaMaxMb ?? cfg.channels?.feishu?.mediaMaxMb ?? 20;
  const maxBytes = Math.max(1, maxMb) * MB;

  const type = (() => {
    switch (ctx.messageType) {
      case "image":
        return "image" as const;
      case "audio":
        return "audio" as const;
      case "media":
        return "video" as const;
      case "file":
        return "file" as const;
      default:
        return null;
    }
  })();

  if (!type) return null;

  const fileKey = type === "image" ? ctx.imageKey : ctx.fileKey;
  if (!fileKey) return null;

  return await downloadFeishuInboundMedia({
    client: ctx.client,
    messageId: ctx.messageId,
    fileKey,
    type,
    maxBytes,
  });
}

/**
 * Dispatch a Feishu message to the agent system
 */
export async function dispatchFeishuMessage(params: DispatchFeishuMessageParams): Promise<void> {
  const { ctx, cfg, runtime, account } = params;
  const log = runtime?.log ?? console.log;

  // Deduplicate messages to prevent processing the same message twice
  const dedupeKey = `feishu:${ctx.messageId}`;
  if (feishuMessageDedupe.check(dedupeKey)) {
    log(`feishu: skipping duplicate message ${ctx.messageId}`);
    return;
  }

  log(
    `feishu: dispatchFeishuMessage called - chatId=${ctx.chatId}, senderId=${ctx.senderId}, chatType=${ctx.chatType}`,
  );

  // Record channel activity
  recordChannelActivity({
    channel: "feishu",
    accountId: account.accountId,
    direction: "inbound",
  });

  const isGroup = ctx.chatType === "group";
  const peerId = buildFeishuPeerId(ctx.chatId, ctx.threadId);

  // Resolve agent route for session key
  const route = resolveAgentRoute({
    cfg,
    channel: "feishu",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: peerId,
    },
  });
  log(`feishu: resolved route - sessionKey=${route.sessionKey}, agentId=${route.agentId}`);

  // Check if sender is allowed
  const accessCheck = isFeishuSenderAllowed(ctx, cfg, account);
  if (!accessCheck.allowed) {
    log(`feishu: blocked message from ${ctx.senderId} (${accessCheck.reason})`);
    return;
  }
  log(`feishu: sender allowed`);

  // Check mention requirement for groups
  if (isGroup && requiresFeishuMention(ctx, cfg, account) && !ctx.wasMentioned) {
    log(`feishu: mention required but not mentioned in group ${ctx.chatId}`);
    return;
  }

  // Resolve inbound media (best-effort). Media-only messages should still trigger.
  let inboundMedia: FeishuInboundMedia | null = null;
  try {
    inboundMedia = await resolveInboundMedia({ ctx, cfg, account });
  } catch (err) {
    runtime?.error?.(danger(`feishu: inbound media download failed: ${formatUncaughtError(err)}`));
  }

  // Skip truly empty messages (no text + no media)
  const rawMessageText = ctx.text.trim() || inboundMedia?.placeholder || "";
  if (!rawMessageText) {
    log(`feishu: skipping empty message (no text/media)`);
    return;
  }

  // Normalize command body (strip bot mention prefix if present)
  const commandBody = normalizeCommandBody(rawMessageText);

  // Check if this is a control command
  const isControlCommand = hasControlCommand(commandBody, cfg, undefined);

  // Apply prompt suffix for non-command messages (enhance user input)
  const promptSuffix = resolvePromptSuffix(ctx, account);
  const messageText =
    !isControlCommand && promptSuffix ? `${rawMessageText}\n\n${promptSuffix}` : rawMessageText;

  log(
    `feishu: processing message - text="${rawMessageText.substring(0, 100)}", isCommand=${isControlCommand}, hasSuffix=${!!promptSuffix}`,
  );

  // Build message context for dispatch
  const envelopeOpts = resolveEnvelopeFormatOptions(cfg);
  const conversationLabel = isGroup ? `group:${ctx.chatId}` : ctx.senderId;

  // Format envelope for agent context (use enhanced messageText with suffix)
  const bodyForAgent = formatInboundEnvelope({
    channel: "Feishu",
    from: conversationLabel,
    body: messageText,
    chatType: isGroup ? "group" : "direct",
    senderLabel: ctx.senderId, // TODO: resolve sender display name
    envelope: envelopeOpts,
  });

  const msgContext = {
    Body: bodyForAgent,
    BodyForAgent: bodyForAgent,
    RawBody: rawMessageText, // Keep original message without suffix
    CommandBody: commandBody,
    BodyForCommands: commandBody,
    From: isGroup ? `feishu:group:${ctx.chatId}` : `feishu:${ctx.chatId}`,
    To: `feishu:${ctx.chatId}`,
    SessionKey: route.sessionKey,
    AccountId: account.accountId,
    MessageSid: ctx.messageId,
    ReplyToId: ctx.replyToMessageId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: conversationLabel,
    Provider: "feishu",
    Surface: "feishu",
    WasMentioned: ctx.wasMentioned,
    SenderId: ctx.senderId,
    Timestamp: Date.now(),
    MessageThreadId: ctx.threadId,
    MediaPath: inboundMedia?.saved.path,
    MediaType: inboundMedia?.saved.contentType,
    MediaUrl: inboundMedia?.saved.path,
    // Commands are authorized if sender passed access checks
    CommandAuthorized: true,
    // Originating channel info for reply routing
    OriginatingChannel: "feishu" as const,
    OriginatingTo: ctx.chatId,
  };

  log(`feishu: dispatching to agent system...`);

  try {
    // Dispatch through the agent system
    await dispatchInboundMessageWithBufferedDispatcher({
      ctx: msgContext,
      cfg,
      dispatcherOptions: {
        deliver: async (payload) => {
          // Check if processing was aborted (message was recalled)
          if (ctx.abortSignal?.aborted) {
            log(`feishu: delivery skipped - message was recalled`);
            return;
          }

          // Collect media URLs from payload
          const mediaUrls = payload.mediaUrls?.length
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];
          const hasMedia = mediaUrls.length > 0;

          log(
            `feishu: deliver callback called - hasText=${!!payload.text}, textLength=${payload.text?.length ?? 0}, mediaCount=${mediaUrls.length}`,
          );

          // Send response back to Feishu; in groups, @mention the user who asked
          if (payload.text) {
            const replyText = payload.text;
            const shouldMention = ctx.chatType === "group" && ctx.senderId;

            try {
              // In groups, send a separate @ mention first (text message)
              // because interactive cards don't support <at> tags in markdown
              if (shouldMention) {
                log(`feishu: sending @ mention to ${ctx.senderId}...`);
                await sendMessageFeishu({
                  to: ctx.chatId,
                  text: `<at user_id="${ctx.senderId}">@</at>`,
                  accountId: account.accountId,
                  config: cfg,
                  receiveIdType: "chat_id",
                  autoRichText: false, // Plain text for @ mention
                });
              }

              log(`feishu: sending reply to ${ctx.chatId}...`);
              const res = await sendMessageFeishu({
                to: ctx.chatId,
                text: replyText,
                accountId: account.accountId,
                config: cfg,
                receiveIdType: "chat_id",
                autoRichText: true, // Enable markdown rendering
                runtime,
              });
              if (!res.success) {
                throw new Error(res.error ?? "feishu sendMessageFeishu failed");
              }
              log(`feishu: reply sent successfully`);
            } catch (sendErr) {
              runtime?.error?.(
                danger(`feishu: failed to send reply: ${formatUncaughtError(sendErr)}`),
              );
            }
          }

          // Send media (images) if present
          if (hasMedia) {
            const maxMb = account.config.mediaMaxMb ?? cfg.channels?.feishu?.mediaMaxMb ?? 20;
            const maxBytes = Math.max(1, maxMb) * MB;
            for (const mediaUrl of mediaUrls) {
              try {
                log(`feishu: loading media from ${mediaUrl}...`);
                const media = await loadWebMedia(mediaUrl, maxBytes);
                if (media.buffer) {
                  const sizeKb = Math.round(media.buffer.length / 1024);
                  log(
                    `feishu: loaded media - kind=${media.kind}, size=${sizeKb}KB, contentType=${media.contentType ?? "unknown"}`,
                  );
                  const kind =
                    media.kind === "image"
                      ? ("image" as const)
                      : media.kind === "audio"
                        ? ("audio" as const)
                        : media.kind === "video"
                          ? ("video" as const)
                          : ("file" as const);

                  log(`feishu: sending media to ${ctx.chatId}...`);
                  const sent = await sendMediaFeishu({
                    to: ctx.chatId,
                    buffer: media.buffer,
                    contentType: media.contentType,
                    fileName: media.fileName,
                    kind,
                    accountId: account.accountId,
                    config: cfg,
                    receiveIdType: "chat_id",
                    runtime,
                  });
                  if (!sent.success) {
                    throw new Error(sent.error ?? "feishu sendMediaFeishu failed");
                  }
                  log(`feishu: media sent successfully (messageId=${sent.messageId ?? "unknown"})`);
                } else {
                  log(`feishu: media load returned no buffer for ${mediaUrl}`);
                }
              } catch (mediaErr) {
                runtime?.error?.(
                  danger(`feishu: failed to send media: ${formatUncaughtError(mediaErr)}`),
                );
              }
            }
          }
        },
        onError: (err) => {
          // Don't report errors for aborted messages
          if (ctx.abortSignal?.aborted) {
            log(`feishu: error ignored - message was recalled`);
            return;
          }
          runtime?.error?.(danger(`feishu: dispatch error: ${formatUncaughtError(err)}`));
        },
      },
    });
    log(`feishu: dispatch completed`);
  } catch (err) {
    // Don't report errors for aborted messages
    if (ctx.abortSignal?.aborted) {
      log(`feishu: dispatch aborted - message was recalled`);
      return;
    }
    runtime?.error?.(danger(`feishu: message dispatch failed: ${formatUncaughtError(err)}`));
  }
}
