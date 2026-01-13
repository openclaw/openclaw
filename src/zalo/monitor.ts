/**
 * Zalo provider monitor - handles inbound messages via polling or webhook
 */

import { chunkMarkdownText } from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ClawdbotConfig } from "../config/config.js";
import { shouldLogVerbose } from "../globals.js";
import { fetchRemoteMedia } from "../media/fetch.js";
import { saveMediaBuffer } from "../media/store.js";
import { buildPairingReply } from "../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  deleteWebhook,
  getUpdates,
  sendMessage as sendZaloMessage,
  sendPhoto as sendZaloPhoto,
  setWebhook,
  ZaloApiError,
  type ZaloMessage,
  type ZaloUpdate,
} from "./api.js";

export type ZaloMonitorOptions = {
  token: string;
  accountId: string;
  config: ClawdbotConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  useWebhook?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath?: string;
  mediaMaxMb?: number;
  historyLimit?: number;
};

export type ZaloMonitorResult = {
  stop: () => void;
};

/**
 * Monitor Zalo for incoming messages
 */
export async function monitorZaloProvider(
  options: ZaloMonitorOptions,
): Promise<ZaloMonitorResult> {
  const {
    token,
    accountId,
    config,
    runtime,
    abortSignal,
    useWebhook,
    webhookUrl,
    webhookSecret,
    mediaMaxMb,
  } = options;

  const effectiveMediaMaxMb = mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;

  let stopped = false;

  const stop = () => {
    stopped = true;
  };

  if (useWebhook && webhookUrl && webhookSecret) {
    // Webhook mode
    await setupWebhookMode(token, webhookUrl, webhookSecret);
  } else {
    // Polling mode - ensure webhook is cleared
    try {
      await deleteWebhook(token);
    } catch {
      // Ignore errors when deleting webhook
    }

    // Start polling loop
    startPollingLoop(
      token,
      accountId,
      config,
      runtime,
      abortSignal,
      () => stopped,
      effectiveMediaMaxMb,
    );
  }

  return { stop };
}

/**
 * Set up webhook mode
 */
async function setupWebhookMode(
  token: string,
  webhookUrl: string,
  webhookSecret: string,
): Promise<void> {
  // Validate webhook URL is HTTPS
  if (!webhookUrl.startsWith("https://")) {
    throw new Error("Zalo webhook URL must use HTTPS");
  }

  // Validate secret length (8-256 chars)
  if (webhookSecret.length < 8 || webhookSecret.length > 256) {
    throw new Error("Zalo webhook secret must be 8-256 characters");
  }

  await setWebhook(token, {
    url: webhookUrl,
    secret_token: webhookSecret,
  });
}

/** Zalo message text limit (2000 characters) */
const ZALO_TEXT_LIMIT = 2000;

/** Default media size limit in MB */
const DEFAULT_MEDIA_MAX_MB = 5;

/** Verbose logging helper */
function logVerbose(message: string): void {
  if (shouldLogVerbose()) {
    console.log(`[zalo] ${message}`);
  }
}

/**
 * Check if a sender is allowed based on allowFrom list
 */
function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) return true;
  const normalizedSenderId = senderId.toLowerCase();
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().replace(/^(zalo|zl):/i, "");
    return normalized === normalizedSenderId;
  });
}

/**
 * Start the long-polling loop for updates
 * Note: Zalo returns a single update per getUpdates call (not an array)
 */
function startPollingLoop(
  token: string,
  accountId: string,
  config: ClawdbotConfig,
  runtime: RuntimeEnv,
  abortSignal: AbortSignal,
  isStopped: () => boolean,
  mediaMaxMb: number,
): void {
  const pollTimeout = 30; // seconds

  const poll = async () => {
    if (isStopped() || abortSignal.aborted) {
      return;
    }

    try {
      const response = await getUpdates(token, {
        timeout: pollTimeout,
      });

      if (response.ok && response.result) {
        // Zalo returns a single update, not an array
        await processUpdate(
          response.result,
          token,
          accountId,
          config,
          runtime,
          mediaMaxMb,
        );
      }
    } catch (err) {
      // 408 timeout is normal for long polling - just means no new messages
      if (err instanceof ZaloApiError && err.isPollingTimeout) {
        // Silent - immediately poll again
      } else if (!isStopped() && !abortSignal.aborted) {
        // Log actual errors but continue polling
        console.error(`[${accountId}] Zalo polling error:`, err);
        // Wait a bit before retrying on error
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    // Schedule next poll
    if (!isStopped() && !abortSignal.aborted) {
      setImmediate(poll);
    }
  };

  // Start polling
  void poll();
}

/**
 * Process an incoming Zalo update
 */
async function processUpdate(
  update: ZaloUpdate,
  token: string,
  accountId: string,
  config: ClawdbotConfig,
  runtime: RuntimeEnv,
  mediaMaxMb: number,
): Promise<void> {
  const { event_name, message } = update;

  if (!message) {
    return;
  }

  // Handle different event types
  switch (event_name) {
    case "message.text.received":
      await handleTextMessage(message, token, accountId, config, runtime);
      break;
    case "message.image.received":
      await handleImageMessage(
        message,
        token,
        accountId,
        config,
        runtime,
        mediaMaxMb,
      );
      break;
    case "message.sticker.received":
      // Stickers are not fully supported yet
      console.log(`[${accountId}] Received sticker from ${message.from.id}`);
      break;
    case "message.unsupported.received":
      // Unsupported message types (e.g., from protected users)
      console.log(
        `[${accountId}] Received unsupported message type from ${message.from.id}`,
      );
      break;
  }
}

/**
 * Handle incoming text message
 */
async function handleTextMessage(
  message: ZaloMessage,
  token: string,
  accountId: string,
  config: ClawdbotConfig,
  runtime: RuntimeEnv,
): Promise<void> {
  const { text } = message;

  if (!text?.trim()) {
    return;
  }

  await processMessageWithPipeline({
    message,
    token,
    accountId,
    config,
    runtime,
    text,
    mediaPath: undefined,
    mediaType: undefined,
  });
}

/**
 * Handle incoming image message
 */
async function handleImageMessage(
  message: ZaloMessage,
  token: string,
  accountId: string,
  config: ClawdbotConfig,
  runtime: RuntimeEnv,
  mediaMaxMb: number,
): Promise<void> {
  const { photo, caption } = message;

  let mediaPath: string | undefined;
  let mediaType: string | undefined;

  // Download and save the image if available
  if (photo) {
    try {
      const maxBytes = mediaMaxMb * 1024 * 1024;
      const fetched = await fetchRemoteMedia({ url: photo });
      const saved = await saveMediaBuffer(
        fetched.buffer,
        fetched.contentType,
        "inbound",
        maxBytes,
      );
      mediaPath = saved.path;
      mediaType = saved.contentType;
    } catch (err) {
      console.error(`[${accountId}] Failed to download Zalo image:`, err);
    }
  }

  await processMessageWithPipeline({
    message,
    token,
    accountId,
    config,
    runtime,
    text: caption,
    mediaPath,
    mediaType,
  });
}

/**
 * Process a message through the agent pipeline
 */
async function processMessageWithPipeline(params: {
  message: ZaloMessage;
  token: string;
  accountId: string;
  config: ClawdbotConfig;
  runtime: RuntimeEnv;
  text?: string;
  mediaPath?: string;
  mediaType?: string;
}): Promise<void> {
  const {
    message,
    token,
    accountId,
    config,
    runtime,
    text,
    mediaPath,
    mediaType,
  } = params;
  const { from, chat, message_id, date } = message;

  const isGroup = chat.chat_type === "GROUP";
  const chatId = chat.id;
  const senderId = from.id;
  const senderName = from.name;

  // Get Zalo config for DM policy
  const zaloCfg = config.channels?.zalo ?? {};
  const dmPolicy = zaloCfg.dmPolicy ?? "pairing";
  const configAllowFrom = (zaloCfg.allowFrom ?? []).map((v) => String(v));

  // DM access control (secure defaults): "pairing" (default) / "allowlist" / "open" / "disabled"
  if (!isGroup) {
    if (dmPolicy === "disabled") {
      logVerbose(`Blocked zalo DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      // Merge config allowFrom with store allowFrom
      const storeAllowFrom = await readChannelAllowFromStore("zalo").catch(
        () => [],
      );
      const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
      const allowed = isSenderAllowed(senderId, effectiveAllowFrom);

      if (!allowed) {
        if (dmPolicy === "pairing") {
          // Create pairing request
          const { code, created } = await upsertChannelPairingRequest({
            channel: "zalo",
            id: senderId,
            meta: {
              name: senderName ?? undefined,
            },
          });

          if (created) {
            logVerbose(`zalo pairing request sender=${senderId}`);
            try {
              await sendZaloMessage(token, {
                chat_id: chatId,
                text: buildPairingReply({
                  channel: "zalo",
                  idLine: `Your Zalo user id: ${senderId}`,
                  code,
                }),
              });
            } catch (err) {
              logVerbose(
                `zalo pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            `Blocked unauthorized zalo sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
        }
        return;
      }
    }
  }

  // Resolve the agent route
  const route = resolveAgentRoute({
    cfg: config,
    channel: "zalo",
    accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: chatId,
    },
  });

  // Build the message body with envelope formatting
  const rawBody = text?.trim() || (mediaPath ? "<media:image>" : "");
  const fromLabel = isGroup
    ? `group:${chatId} from ${senderName || senderId}`
    : senderName || `user:${senderId}`;
  const body = formatAgentEnvelope({
    channel: "Zalo",
    from: fromLabel,
    timestamp: date ? date * 1000 : undefined,
    body: rawBody,
  });

  // Build MsgContext for the agent
  const ctxPayload: MsgContext = {
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `group:${chatId}` : `zalo:${senderId}`,
    To: `zalo:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    SenderName: senderName || undefined,
    SenderId: senderId,
    Provider: "zalo",
    Surface: "zalo",
    MessageSid: message_id,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    OriginatingChannel: "zalo" as const,
    OriginatingTo: `zalo:${chatId}`,
  };

  // Dispatch to the agent pipeline
  await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload: ReplyPayload) => {
        await deliverZaloReply({
          payload,
          token,
          chatId,
          runtime,
        });
      },
      onError: (err, info) => {
        runtime.error?.(
          `[${accountId}] Zalo ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
  });
}

/**
 * Deliver a reply payload to Zalo
 */
async function deliverZaloReply(params: {
  payload: ReplyPayload;
  token: string;
  chatId: string;
  runtime: RuntimeEnv;
}): Promise<void> {
  const { payload, token, chatId, runtime } = params;

  // Handle media URLs
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    // Send media with optional caption
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first ? payload.text : undefined;
      first = false;
      try {
        await sendZaloPhoto(token, {
          chat_id: chatId,
          photo: mediaUrl,
          caption,
        });
      } catch (err) {
        runtime.error?.(`Zalo photo send failed: ${String(err)}`);
      }
    }
    return;
  }

  // Send text message, chunked to 2000 char limit
  if (payload.text) {
    const chunks = chunkMarkdownText(payload.text, ZALO_TEXT_LIMIT);
    for (const chunk of chunks) {
      try {
        await sendZaloMessage(token, {
          chat_id: chatId,
          text: chunk,
        });
      } catch (err) {
        runtime.error?.(`Zalo message send failed: ${String(err)}`);
      }
    }
  }
}

/**
 * Handle incoming Zalo webhook request
 * This can be used by the gateway's HTTP server to process webhook events
 */
export function handleZaloWebhook(
  body: unknown,
  token: string,
  secretToken: string,
  headerToken: string,
  accountId: string,
  config: ClawdbotConfig,
  runtime: RuntimeEnv,
  mediaMaxMb?: number,
): { ok: boolean; error?: string } {
  // Verify the secret token
  if (headerToken !== secretToken) {
    return { ok: false, error: "Invalid secret token" };
  }

  // Parse the webhook payload
  const payload = body as { ok?: boolean; result?: ZaloUpdate };

  if (!payload.ok || !payload.result) {
    return { ok: false, error: "Invalid webhook payload" };
  }

  const effectiveMediaMaxMb = mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;

  // Process the update asynchronously
  processUpdate(
    payload.result,
    token,
    accountId,
    config,
    runtime,
    effectiveMediaMaxMb,
  ).catch((err) => {
    console.error(`[${accountId}] Error processing Zalo webhook:`, err);
  });

  return { ok: true };
}
