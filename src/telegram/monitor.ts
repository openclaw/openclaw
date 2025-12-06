/**
 * Telegram Relay Monitor
 *
 * Monitors incoming Telegram messages and handles auto-reply via the Provider interface.
 */

import { chunkText } from "../auto-reply/chunk.js";
import { getReplyFromConfig, type ReplyPayload } from "../auto-reply/reply.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { loadConfig } from "../config/config.js";
import { readEnv } from "../env.js";
import { danger, info, isVerbose, logVerbose, success } from "../globals.js";
import type { Provider } from "../providers/base/interface.js";
import type {
  ProviderMessage,
  TelegramProviderConfig,
} from "../providers/base/types.js";
import { createInitializedProvider } from "../providers/factory.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeAllowFromEntry } from "../utils.js";

const TELEGRAM_TEXT_LIMIT = 4096; // Telegram's message length limit

/**
 * Format timestamp in the same format as WhatsApp relay.
 * Example: [Dec 5 22:41]
 */
function formatTimestamp(ts: number, config?: ReturnType<typeof loadConfig>): string {
  const tsCfg = config?.inbound?.timestampPrefix;
  const tsEnabled = tsCfg !== false; // default true
  if (!tsEnabled) return "";
  const tz = typeof tsCfg === "string" ? tsCfg : "UTC";
  const date = new Date(ts);
  try {
    return `[${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz })} ${date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz })}] `;
  } catch {
    return `[${date.toISOString().slice(5, 16).replace("T", " ")}] `;
  }
}

/**
 * Convert ProviderMessage to MsgContext for auto-reply system.
 */
function providerMessageToContext(
  message: ProviderMessage,
  config?: ReturnType<typeof loadConfig>,
): MsgContext {
  const timestampPrefix = formatTimestamp(message.timestamp, config);
  const bodyWithTimestamp = timestampPrefix
    ? `${timestampPrefix}${message.body}`
    : message.body;

  return {
    Body: bodyWithTimestamp,
    From: message.from,
    To: message.to,
    MessageSid: message.id,
    MediaUrl: message.media?.[0]?.url,
    MediaType: message.media?.[0]?.mimeType,
    MediaPath: message.media?.[0]?.fileName,
  };
}

/**
 * Send a reply payload via the provider.
 */
async function sendReply(
  provider: Provider,
  replyTo: string,
  payload: ReplyPayload,
  runtime: RuntimeEnv,
): Promise<void> {
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  const text = payload.text ?? "";
  const chunks = chunkText(text, TELEGRAM_TEXT_LIMIT);
  if (chunks.length === 0 && mediaList.length === 0) {
    return; // Nothing to send
  }

  // Send first chunk with first media (if any)
  if (chunks.length > 0 || mediaList.length > 0) {
    const firstChunk = chunks.length > 0 ? chunks[0] : "";
    const firstMedia = mediaList[0];

    try {
      const result = await provider.send(replyTo, firstChunk, {
        media: firstMedia ? [{ type: "image", url: firstMedia }] : undefined,
      });

      // Log the reply text
      runtime.log(`↩️  ${firstChunk}`);

      if (isVerbose()) {
        runtime.log(
          success(
            `Auto-replied to ${replyTo} via Telegram (id ${result.messageId})`,
          ),
        );
      }
    } catch (err) {
      runtime.error(danger(`Failed to send Telegram reply: ${String(err)}`));
      throw err;
    }
  }

  // Send remaining text chunks (no media)
  for (let i = 1; i < chunks.length; i++) {
    try {
      await provider.send(replyTo, chunks[i]);
      runtime.log(`↩️  ${chunks[i]}`);
    } catch (err) {
      runtime.error(
        danger(`Failed to send Telegram reply chunk ${i}: ${String(err)}`),
      );
    }
  }

  // Send remaining media (without text)
  for (let i = 1; i < mediaList.length; i++) {
    try {
      await provider.send(replyTo, "", {
        media: [{ type: "image", url: mediaList[i] }],
      });
    } catch (err) {
      runtime.error(
        danger(`Failed to send Telegram media ${i}: ${String(err)}`),
      );
    }
  }
}

/**
 * Handle an inbound message with auto-reply logic.
 */
async function handleInboundMessage(
  message: ProviderMessage,
  provider: Provider,
  runtime: RuntimeEnv,
): Promise<void> {
  const config = loadConfig();
  const ctx = providerMessageToContext(message, config);

  // Check allowFrom filter
  const allowFrom = config.inbound?.allowFrom;
  if (Array.isArray(allowFrom) && allowFrom.length > 0) {
    if (!allowFrom.includes("*")) {
      const normalizedFrom = normalizeAllowFromEntry(message.from, "telegram");
      const normalizedAllowList = allowFrom.map((e) =>
        normalizeAllowFromEntry(e, "telegram"),
      );
      if (!normalizedAllowList.includes(normalizedFrom)) {
        if (isVerbose()) {
          logVerbose(
            `Skipping auto-reply: sender ${message.from} not in allowFrom list`,
          );
        }
        return;
      }
    }
  }

  // Log inbound message
  const formattedTs = formatTimestamp(message.timestamp, config);
  runtime.log(
    `\n${formattedTs}${message.from} -> ${message.to}: ${message.body}`,
  );

  // Get reply from config
  const replyResult = await getReplyFromConfig(
    ctx,
    {
      onReplyStart: async () => {
        try {
          await provider.sendTyping(message.from);
        } catch {
          // Typing indicator is optional
        }
      },
    },
    config,
  );

  // Handle replies
  const replies = replyResult
    ? Array.isArray(replyResult)
      ? replyResult
      : [replyResult]
    : [];

  if (replies.length === 0) {
    logVerbose("No auto-reply configured or reply was empty");
    return;
  }

  // Send each reply
  for (const payload of replies) {
    await sendReply(provider, message.from, payload, runtime);
  }
}

/**
 * Start monitoring Telegram for inbound messages with auto-reply.
 *
 * This function:
 * - Reads Telegram config from environment
 * - Creates and initializes a TelegramProvider
 * - Registers message handler with auto-reply logic
 * - Starts listening for messages
 * - Runs indefinitely until interrupted or abort signal fires
 *
 * @param verbose - Enable verbose logging
 * @param runtime - Runtime environment (for testing)
 * @param abortSignal - Optional AbortSignal to stop monitoring gracefully
 */
export async function monitorTelegramProvider(
  verbose: boolean,
  runtime: RuntimeEnv = defaultRuntime,
  abortSignal?: AbortSignal,
  suppressStartMessage = false,
): Promise<void> {
  const env = readEnv(runtime);
  const config = loadConfig();

  if (!env.telegram?.apiId || !env.telegram?.apiHash) {
    throw new Error(
      "Telegram not configured. Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env",
    );
  }

  const providerConfig: TelegramProviderConfig = {
    kind: "telegram",
    apiId: Number.parseInt(env.telegram.apiId, 10),
    apiHash: env.telegram.apiHash,
    sessionDir: undefined, // Uses default ~/.warelay/telegram
    allowFrom: config.inbound?.allowFrom,
    verbose,
  };

  if (!suppressStartMessage) {
    runtime.log(info("📡 Starting Telegram relay..."));
  }

  // Create and initialize provider
  const provider = await createInitializedProvider("telegram", providerConfig);

  if (!provider.isConnected()) {
    throw new Error("Failed to connect to Telegram");
  }

  const sessionId = await provider.getSessionId();
  runtime.log(info(`✅ Connected as: ${sessionId ?? "unknown"}`));

  // Set up message handler with auto-reply
  provider.onMessage(async (message: ProviderMessage) => {
    try {
      await handleInboundMessage(message, provider, runtime);
    } catch (err) {
      runtime.error(danger(`Error handling Telegram message: ${String(err)}`));
    }
  });

  // Start listening
  await provider.startListening();

  if (!suppressStartMessage) {
    runtime.log(
      info(
        "✅ Telegram relay active. Listening for messages... (Ctrl+C to stop)",
      ),
    );
  }

  // Keep process alive until abort signal or forever
  if (abortSignal) {
    await new Promise<void>((resolve) => {
      if (abortSignal.aborted) {
        resolve();
        return;
      }
      abortSignal.addEventListener("abort", () => resolve());
    });
    runtime.log(info("📡 Telegram relay stopping..."));
  } else {
    // No abort signal: run indefinitely
    await new Promise(() => {
      // Never resolves - process runs until interrupted
    });
  }
}
