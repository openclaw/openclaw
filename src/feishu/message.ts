import type { Client } from "@larksuiteoapi/node-sdk";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getChildLogger } from "../logging.js";
import { isSenderAllowed, normalizeAllowFromWithStore, resolveSenderAllowMatch } from "./access.js";
import {
  resolveFeishuConfig,
  resolveFeishuGroupConfig,
  resolveFeishuGroupEnabled,
  type ResolvedFeishuConfig,
} from "./config.js";
import { resolveFeishuMedia, type FeishuMediaRef } from "./download.js";
import { readFeishuAllowFromStore, upsertFeishuPairingRequest } from "./pairing-store.js";
import { sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";

const logger = getChildLogger({ module: "feishu-message" });

type FeishuSender = {
  sender_id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
};

type FeishuMention = {
  key?: string;
};

type FeishuMessage = {
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  mentions?: FeishuMention[];
  create_time?: string | number;
  message_id?: string;
};

type FeishuEventPayload = {
  message?: FeishuMessage;
  event?: {
    message?: FeishuMessage;
    sender?: FeishuSender;
  };
  sender?: FeishuSender;
  mentions?: FeishuMention[];
};

// Supported message types for processing
const SUPPORTED_MSG_TYPES = new Set(["text", "image", "file", "audio", "media", "sticker"]);

export type ProcessFeishuMessageOptions = {
  cfg?: OpenClawConfig;
  accountId?: string;
  resolvedConfig?: ResolvedFeishuConfig;
  /** Feishu app credentials for streaming card API */
  credentials?: { appId: string; appSecret: string; domain?: string };
  /** Bot name for streaming card title (optional, defaults to no title) */
  botName?: string;
};

export async function processFeishuMessage(
  client: Client,
  data: unknown,
  appId: string,
  options: ProcessFeishuMessageOptions = {},
) {
  const cfg = options.cfg ?? loadConfig();
  const accountId = options.accountId ?? appId;
  const feishuCfg = options.resolvedConfig ?? resolveFeishuConfig({ cfg, accountId });

  const payload = data as FeishuEventPayload;

  // SDK 2.0 schema: data directly contains message, sender, etc.
  const message = payload.message ?? payload.event?.message;
  const sender = payload.sender ?? payload.event?.sender;

  if (!message) {
    logger.warn(`Received event without message field`);
    return;
  }

  const chatId = message.chat_id;
  if (!chatId) {
    logger.warn("Received message without chat_id");
    return;
  }
  const isGroup = message.chat_type === "group";
  const msgType = message.message_type;
  const senderId = sender?.sender_id?.open_id || sender?.sender_id?.user_id || "unknown";
  const senderUnionId = sender?.sender_id?.union_id;
  const maxMediaBytes = feishuCfg.mediaMaxMb * 1024 * 1024;

  // Check if this is a supported message type
  if (!msgType || !SUPPORTED_MSG_TYPES.has(msgType)) {
    logger.debug(`Skipping unsupported message type: ${msgType ?? "unknown"}`);
    return;
  }

  // Load allowlist from store
  const storeAllowFrom = await readFeishuAllowFromStore().catch(() => []);

  // ===== Access Control =====

  // Group access control
  if (isGroup) {
    // Check if group is enabled
    if (!resolveFeishuGroupEnabled({ cfg, accountId, chatId })) {
      logVerbose(`Blocked feishu group ${chatId} (group disabled)`);
      return;
    }

    const { groupConfig } = resolveFeishuGroupConfig({ cfg, accountId, chatId });

    // Check group-level allowFrom override
    if (groupConfig?.allowFrom) {
      const groupAllow = normalizeAllowFromWithStore({
        allowFrom: groupConfig.allowFrom,
        storeAllowFrom,
      });
      if (!isSenderAllowed({ allow: groupAllow, senderId })) {
        logVerbose(`Blocked feishu group sender ${senderId} (group allowFrom override)`);
        return;
      }
    }

    // Apply groupPolicy
    const groupPolicy = feishuCfg.groupPolicy;
    if (groupPolicy === "disabled") {
      logVerbose(`Blocked feishu group message (groupPolicy: disabled)`);
      return;
    }

    if (groupPolicy === "allowlist") {
      const groupAllow = normalizeAllowFromWithStore({
        allowFrom:
          feishuCfg.groupAllowFrom.length > 0 ? feishuCfg.groupAllowFrom : feishuCfg.allowFrom,
        storeAllowFrom,
      });
      if (!groupAllow.hasEntries) {
        logVerbose(`Blocked feishu group message (groupPolicy: allowlist, no entries)`);
        return;
      }
      if (!isSenderAllowed({ allow: groupAllow, senderId })) {
        logVerbose(`Blocked feishu group sender ${senderId} (groupPolicy: allowlist)`);
        return;
      }
    }
  }

  // DM access control
  if (!isGroup) {
    const dmPolicy = feishuCfg.dmPolicy;

    if (dmPolicy === "disabled") {
      logVerbose(`Blocked feishu DM (dmPolicy: disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const dmAllow = normalizeAllowFromWithStore({
        allowFrom: feishuCfg.allowFrom,
        storeAllowFrom,
      });
      const allowMatch = resolveSenderAllowMatch({ allow: dmAllow, senderId });
      const allowed = dmAllow.hasWildcard || (dmAllow.hasEntries && allowMatch.allowed);

      if (!allowed) {
        if (dmPolicy === "pairing") {
          // Generate pairing code for unknown sender
          try {
            const { code, created } = await upsertFeishuPairingRequest({
              openId: senderId,
              unionId: senderUnionId,
              name: sender?.sender_id?.user_id,
            });
            if (created) {
              logger.info({ openId: senderId, unionId: senderUnionId }, "feishu pairing request");
              await sendMessageFeishu(
                client,
                senderId,
                {
                  text: [
                    "OpenClaw access not configured.",
                    "",
                    `Your Feishu Open ID: ${senderId}`,
                    "",
                    `Pairing code: ${code}`,
                    "",
                    "Ask the OpenClaw admin to approve with:",
                    `openclaw pairing approve feishu ${code}`,
                  ].join("\n"),
                },
                { receiveIdType: "open_id" },
              );
            }
          } catch (err) {
            logger.error(`Failed to create pairing request: ${formatErrorMessage(err)}`);
          }
          return;
        }

        // allowlist policy: silently block
        logVerbose(`Blocked feishu DM from ${senderId} (dmPolicy: allowlist)`);
        return;
      }
    }
  }

  // Handle @mentions for group chats
  const mentions = message.mentions ?? payload.mentions ?? [];
  const wasMentioned = mentions.length > 0;

  // In group chat, check requireMention setting
  if (isGroup) {
    const { groupConfig } = resolveFeishuGroupConfig({ cfg, accountId, chatId });
    const requireMention = groupConfig?.requireMention ?? true;
    if (requireMention && !wasMentioned) {
      logger.debug(`Ignoring group message without @mention (requireMention: true)`);
      return;
    }
  }

  // Extract text content (for text messages or captions)
  let text = "";
  if (msgType === "text") {
    try {
      if (message.content) {
        const content = JSON.parse(message.content);
        text = content.text || "";
      }
    } catch (err) {
      logger.error(`Failed to parse text message content: ${formatErrorMessage(err)}`);
    }
  }

  // Remove @mention placeholders from text
  for (const mention of mentions) {
    if (mention.key) {
      text = text.replace(mention.key, "").trim();
    }
  }

  // Resolve media if present
  let media: FeishuMediaRef | null = null;
  if (msgType !== "text") {
    try {
      media = await resolveFeishuMedia(client, message, maxMediaBytes);
    } catch (err) {
      logger.error(`Failed to download media: ${formatErrorMessage(err)}`);
    }
  }

  // Build body text
  let bodyText = text;
  if (!bodyText && media) {
    bodyText = media.placeholder;
  }

  // Skip if no content
  if (!bodyText && !media) {
    logger.debug(`Empty message after processing, skipping`);
    return;
  }

  const senderName = sender?.sender_id?.user_id || "unknown";

  // Streaming mode support
  const streamingEnabled = (feishuCfg.streaming ?? true) && Boolean(options.credentials);
  const streamingSession =
    streamingEnabled && options.credentials
      ? new FeishuStreamingSession(client, options.credentials)
      : null;
  let streamingStarted = false;
  let lastPartialText = "";

  // Context construction
  const ctx = {
    Body: bodyText,
    RawBody: text || media?.placeholder || "",
    From: senderId,
    To: chatId,
    SenderId: senderId,
    SenderName: senderName,
    ChatType: isGroup ? "group" : "dm",
    Provider: "feishu",
    Surface: "feishu",
    Timestamp: Number(message.create_time),
    MessageSid: message.message_id,
    AccountId: accountId,
    OriginatingChannel: "feishu",
    OriginatingTo: chatId,
    // Media fields (similar to Telegram)
    MediaPath: media?.path,
    MediaType: media?.contentType,
    MediaUrl: media?.path,
    WasMentioned: isGroup ? wasMentioned : undefined,
  };

  const agentId = resolveSessionAgentId({ config: cfg });
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId,
    channel: "feishu",
    accountId,
  });

  await dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload, info) => {
        const hasMedia = payload.mediaUrl || (payload.mediaUrls && payload.mediaUrls.length > 0);
        if (!payload.text && !hasMedia) {
          return;
        }

        // Handle block replies - update streaming card with partial text
        if (streamingSession?.isActive() && info?.kind === "block" && payload.text) {
          logger.debug(`Updating streaming card with block text: ${payload.text.length} chars`);
          await streamingSession.update(payload.text);
          return;
        }

        // If streaming was active, close it with the final text
        if (streamingSession?.isActive() && info?.kind === "final") {
          await streamingSession.close(payload.text);
          streamingStarted = false;
          return; // Card already contains the final text
        }

        // Handle media URLs
        const mediaUrls = payload.mediaUrls?.length
          ? payload.mediaUrls
          : payload.mediaUrl
            ? [payload.mediaUrl]
            : [];

        if (mediaUrls.length > 0) {
          // Close streaming session before sending media
          if (streamingSession?.isActive()) {
            await streamingSession.close();
            streamingStarted = false;
          }
          // Send each media item
          for (let i = 0; i < mediaUrls.length; i++) {
            const mediaUrl = mediaUrls[i];
            const caption = i === 0 ? payload.text || "" : "";
            await sendMessageFeishu(
              client,
              chatId,
              { text: caption },
              {
                mediaUrl,
                receiveIdType: "chat_id",
              },
            );
          }
        } else if (payload.text) {
          // If streaming wasn't used, send as regular message
          if (!streamingSession?.isActive()) {
            await sendMessageFeishu(
              client,
              chatId,
              { text: payload.text },
              {
                msgType: "text",
                receiveIdType: "chat_id",
              },
            );
          }
        }
      },
      onError: (err) => {
        logger.error(`Reply error: ${formatErrorMessage(err)}`);
        // Clean up streaming session on error
        if (streamingSession?.isActive()) {
          streamingSession.close().catch(() => {});
        }
      },
      onReplyStart: async () => {
        // Start streaming card when reply generation begins
        if (streamingSession && !streamingStarted) {
          try {
            await streamingSession.start(chatId, "chat_id", options.botName);
            streamingStarted = true;
            logger.debug(`Started streaming card for chat ${chatId}`);
          } catch (err) {
            logger.warn(`Failed to start streaming card: ${formatErrorMessage(err)}`);
            // Continue without streaming
          }
        }
      },
    },
    replyOptions: {
      disableBlockStreaming: !feishuCfg.blockStreaming,
      onModelSelected,
      onPartialReply: streamingSession
        ? async (payload) => {
            if (!streamingSession.isActive() || !payload.text) {
              return;
            }
            if (payload.text === lastPartialText) {
              return;
            }
            lastPartialText = payload.text;
            await streamingSession.update(payload.text);
          }
        : undefined,
      onReasoningStream: streamingSession
        ? async (payload) => {
            // Also update on reasoning stream for extended thinking models
            if (!streamingSession.isActive() || !payload.text) {
              return;
            }
            if (payload.text === lastPartialText) {
              return;
            }
            lastPartialText = payload.text;
            await streamingSession.update(payload.text);
          }
        : undefined,
    },
  });

  // Ensure streaming session is closed on completion
  if (streamingSession?.isActive()) {
    await streamingSession.close();
  }
}
