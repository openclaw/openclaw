import type { Client } from "@larksuiteoapi/node-sdk";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getChildLogger } from "../logging.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { isSenderAllowed, normalizeAllowFromWithStore, resolveSenderAllowMatch } from "./access.js";
import {
  resolveFeishuConfig,
  resolveFeishuGroupConfig,
  resolveFeishuGroupEnabled,
  type ResolvedFeishuConfig,
} from "./config.js";
import { resolveFeishuDocsFromMessage } from "./docs.js";
import {
  downloadPostImages,
  extractPostImageKeys,
  resolveFeishuMedia,
  type FeishuMediaRef,
} from "./download.js";
import { readFeishuAllowFromStore, upsertFeishuPairingRequest } from "./pairing-store.js";
import { sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { createTypingIndicatorCallbacks } from "./typing.js";
import { getFeishuUserDisplayName } from "./user.js";

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
  id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  name?: string;
};

type FeishuMessage = {
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  mentions?: FeishuMention[];
  create_time?: string | number;
  message_id?: string;
  parent_id?: string;
  root_id?: string;
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
const SUPPORTED_MSG_TYPES = new Set(["text", "post", "image", "file", "audio", "media", "sticker"]);

export type ProcessFeishuMessageOptions = {
  cfg?: OpenClawConfig;
  accountId?: string;
  resolvedConfig?: ResolvedFeishuConfig;
  /** Feishu app credentials for streaming card API */
  credentials?: { appId: string; appSecret: string; domain?: string };
  /** Bot name for streaming card title (optional, defaults to no title) */
  botName?: string;
  /** Bot's open_id for detecting bot mentions in groups */
  botOpenId?: string;
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

  // Resolve agent route for multi-agent support
  const route = resolveAgentRoute({
    cfg,
    channel: "feishu",
    accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: isGroup ? chatId : senderId,
    },
  });

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
  // Check if the bot itself was mentioned, not just any user
  const botOpenId = options.botOpenId?.trim();
  const wasMentioned = botOpenId
    ? mentions.some((m) => m.id?.open_id === botOpenId || m.id?.user_id === botOpenId)
    : mentions.length > 0;

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
  } else if (msgType === "post") {
    // Post (rich text) message parsing
    // Feishu post content can have two formats:
    // Format 1: { post: { zh_cn: { title, content } } } (locale-wrapped)
    // Format 2: { title, content } (direct)
    try {
      const content = JSON.parse(message.content ?? "{}");
      const parts: string[] = [];

      // Try to find the actual post content
      let postData = content;
      if (content.post && typeof content.post === "object") {
        // Find the first locale key (zh_cn, en_us, etc.)
        const localeKey = Object.keys(content.post).find(
          (key) => content.post[key]?.content || content.post[key]?.title,
        );
        if (localeKey) {
          postData = content.post[localeKey];
        }
      }

      // Include title if present
      if (postData.title) {
        parts.push(postData.title);
      }

      // Extract text from content elements
      if (Array.isArray(postData.content)) {
        for (const line of postData.content) {
          if (!Array.isArray(line)) {
            continue;
          }
          const lineParts: string[] = [];
          for (const element of line) {
            if (element.tag === "text" && element.text) {
              lineParts.push(element.text);
            } else if (element.tag === "a" && element.text) {
              lineParts.push(element.text);
            } else if (element.tag === "at" && element.user_name) {
              lineParts.push(`@${element.user_name}`);
            }
          }
          if (lineParts.length > 0) {
            parts.push(lineParts.join(""));
          }
        }
      }

      text = parts.join("\n");
    } catch (err) {
      logger.error(`Failed to parse post message content: ${formatErrorMessage(err)}`);
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
  let postImages: FeishuMediaRef[] = [];

  if (msgType === "post") {
    // Extract and download embedded images from post message
    try {
      const content = JSON.parse(message.content ?? "{}");
      const imageKeys = extractPostImageKeys(content);
      if (imageKeys.length > 0 && message.message_id) {
        postImages = await downloadPostImages(
          client,
          message.message_id,
          imageKeys,
          maxMediaBytes,
          5, // max 5 images per post
        );
        logger.debug(
          `Downloaded ${postImages.length}/${imageKeys.length} images from post message`,
        );
      }
    } catch (err) {
      logger.error(`Failed to download post images: ${formatErrorMessage(err)}`);
    }
  } else if (msgType !== "text") {
    try {
      media = await resolveFeishuMedia(client, message, maxMediaBytes);
    } catch (err) {
      logger.error(`Failed to download media: ${formatErrorMessage(err)}`);
    }
  }

  // Resolve document content if message contains Feishu doc links
  let docContent: string | null = null;
  if (msgType === "text" || msgType === "post") {
    try {
      docContent = await resolveFeishuDocsFromMessage(client, message, {
        maxDocsPerMessage: 3,
        maxTotalLength: 100000,
        domain: options.credentials?.domain,
      });
      if (docContent) {
        logger.debug(`Resolved ${docContent.length} chars of document content`);
      }
    } catch (err) {
      logger.error(`Failed to resolve document content: ${formatErrorMessage(err)}`);
    }
  }

  // Build body text
  let bodyText = text;
  if (!bodyText && media) {
    bodyText = media.placeholder;
  }

  // Append document content if available
  if (docContent) {
    bodyText = bodyText ? `${bodyText}\n\n${docContent}` : docContent;
  }

  // Skip if no content
  if (!bodyText && !media && postImages.length === 0) {
    logger.debug(`Empty message after processing, skipping`);
    return;
  }

  // Get sender display name (try to fetch from contact API, fallback to user_id)
  const fallbackName = sender?.sender_id?.user_id || "unknown";
  const senderName = await getFeishuUserDisplayName(client, senderId, fallbackName);

  // Streaming mode support
  const streamingEnabled = (feishuCfg.streaming ?? true) && Boolean(options.credentials);
  const streamingSession =
    streamingEnabled && options.credentials
      ? new FeishuStreamingSession(client, options.credentials)
      : null;
  let streamingStarted = false;
  let lastPartialText = "";

  // Typing indicator callbacks (for non-streaming mode)
  const typingCallbacks = createTypingIndicatorCallbacks(client, message.message_id);

  // Use first post image as primary media if no other media
  const primaryMedia = media ?? (postImages.length > 0 ? postImages[0] : null);
  const additionalMediaPaths = postImages.length > 1 ? postImages.slice(1).map((m) => m.path) : [];

  // Reply/Thread metadata for inbound messages
  const replyToId = message.parent_id ?? message.root_id;
  const messageThreadId = message.root_id ?? undefined;

  // Context construction
  const ctx = {
    Body: bodyText,
    RawBody: text || primaryMedia?.placeholder || "",
    From: senderId,
    To: chatId,
    SessionKey: route.sessionKey,
    SenderId: senderId,
    SenderName: senderName,
    ChatType: isGroup ? "group" : "dm",
    Provider: "feishu",
    Surface: "feishu",
    Timestamp: Number(message.create_time),
    MessageSid: message.message_id,
    AccountId: route.accountId,
    OriginatingChannel: "feishu",
    OriginatingTo: chatId,
    // Media fields (similar to Telegram)
    MediaPath: primaryMedia?.path,
    MediaType: primaryMedia?.contentType,
    MediaUrl: primaryMedia?.path,
    // Additional images from post messages
    MediaUrls: additionalMediaPaths.length > 0 ? additionalMediaPaths : undefined,
    WasMentioned: isGroup ? wasMentioned : undefined,
    // Reply/thread metadata when the inbound message is a reply
    MessageThreadId: messageThreadId,
    ReplyToId: replyToId,
    // Command authorization - if message reached here, sender passed access control
    CommandAuthorized: true,
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
                // Only reply to the first media item to avoid spamming quote replies
                replyToMessageId: i === 0 ? payload.replyToId : undefined,
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
                replyToMessageId: payload.replyToId,
              },
            );
          }
        }
      },
      onError: (err) => {
        const msg = formatErrorMessage(err);
        if (
          msg.includes("permission") ||
          msg.includes("forbidden") ||
          msg.includes("code: 99991660")
        ) {
          logger.error(
            `Reply error: ${msg} (Check if "im:message" or "im:resource" permissions are enabled in Feishu Console)`,
          );
        } else {
          logger.error(`Reply error: ${msg}`);
        }
        // Clean up streaming session on error
        if (streamingSession?.isActive()) {
          streamingSession.close().catch(() => {});
        }
        // Clean up typing indicator on error
        typingCallbacks.onIdle().catch(() => {});
      },
      onReplyStart: async () => {
        // Add typing indicator reaction (for non-streaming fallback)
        if (!streamingSession) {
          await typingCallbacks.onReplyStart();
        }
        // Start streaming card when reply generation begins
        if (streamingSession && !streamingStarted) {
          try {
            await streamingSession.start(chatId, "chat_id", options.botName);
            streamingStarted = true;
            logger.debug(`Started streaming card for chat ${chatId}`);
          } catch (err) {
            const msg = formatErrorMessage(err);
            if (msg.includes("permission") || msg.includes("forbidden")) {
              logger.warn(
                `Failed to start streaming card: ${msg} (Check if "im:resource:msg:send" or card permissions are enabled)`,
              );
            } else {
              logger.warn(`Failed to start streaming card: ${msg}`);
            }
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

  // Clean up typing indicator
  await typingCallbacks.onIdle();
}
