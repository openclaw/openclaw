/**
 * LINQ polling monitor — fetches new inbound messages from the LINQ API
 * and dispatches them to the agent system.
 *
 * Since LINQ uses webhooks for inbound in production, this polling fallback
 * is useful when a public webhook URL is not available.
 */

import type { OpenClawConfig } from "../config/config.js";
import type { LinqAccountConfig } from "../config/types.linq.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveHumanDelayConfig } from "../agents/identity.js";
import { resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import {
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions,
} from "../auto-reply/envelope.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { resolveControlCommandGate } from "../channels/command-gating.js";
import { logInboundDrop } from "../channels/logging.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { recordInboundSession } from "../channels/session.js";
import { readSessionUpdatedAt, resolveStorePath } from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";

// Direct console logging for the polling monitor since logVerbose
// relies on globalVerbose which isn't set inside jiti-loaded extensions.
const linqLog = (msg: string) => console.log(`[linq] ${msg}`);
const linqWarn = (msg: string) => console.warn(`[linq] ${msg}`);
import { buildPairingReply } from "../pairing/pairing-messages.js";
import { upsertChannelPairingRequest } from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { truncateUtf16Safe } from "../utils.js";
import { LinqClient, type LinqMessage, type LinqChat } from "./client.js";
import { resolveLinqAccount } from "./accounts.js";
import { sendMessageLinq } from "./send.js";

export type MonitorLinqOpts = {
  cfg?: OpenClawConfig;
  accountId?: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  pollIntervalMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 2000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function monitorLinqProvider(opts: MonitorLinqOpts = {}): Promise<void> {
  const { loadConfig } = await import("../config/config.js");
  let cfg = opts.cfg ?? (await loadConfig());
  const runtime = opts.runtime;
  const account = resolveLinqAccount({ cfg, accountId: opts.accountId });
  const token = account.config.apiToken;
  const fromNumber = account.config.fromNumber;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  if (!token || !fromNumber) {
    runtime?.error?.("linq: API token and fromNumber are required for polling");
    return;
  }

  const client = new LinqClient(token);
  const processedMessageIds = new Set<string>();
  // Track known chat IDs so we can poll them individually
  const knownChatIds = new Set<string>();

  // Seed processed messages: fetch existing messages so we don't replay history
  try {
    const chats = await client.listChats({ from: fromNumber, limit: 100 });
    for (const chat of chats.chats) {
      knownChatIds.add(chat.id);
      try {
        const msgs = await client.listMessages(chat.id, { limit: 20 });
        for (const msg of msgs.messages) {
          processedMessageIds.add(msg.id);
        }
      } catch {
        // ignore per-chat fetch errors during seed
      }
    }
    linqLog(
      `seeded ${processedMessageIds.size} existing messages across ${knownChatIds.size} chats`,
    );
  } catch (err) {
    runtime?.error?.(`linq: failed to seed message history: ${String(err)}`);
  }

  // Main polling loop
  while (!opts.abortSignal?.aborted) {
    try {
      // Reload config periodically
      cfg = await loadConfig();
      const currentAccount = resolveLinqAccount({ cfg, accountId: opts.accountId });
      if (!currentAccount.enabled) {
        linqLog("account disabled, stopping poll");
        break;
      }

      // Discover new chats
      const chatResult = await client.listChats({ from: fromNumber, limit: 100 });
      for (const chat of chatResult.chats) {
        knownChatIds.add(chat.id);
      }

      // Poll each known chat for new messages
      for (const chatId of knownChatIds) {
        if (opts.abortSignal?.aborted) break;
        try {
          const msgResult = await client.listMessages(chatId, { limit: 20 });
          const newMessages = msgResult.messages.filter(
            (msg) => !processedMessageIds.has(msg.id) && !msg.is_from_me,
          );

          for (const msg of newMessages) {
            processedMessageIds.add(msg.id);
            // Find the chat object for context
            const chat = chatResult.chats.find((c) => c.id === chatId);
            try {
              await handleInboundMessage({
                cfg,
                account: currentAccount,
                client,
                chat,
                chatId,
                message: msg,
                fromNumber,
                runtime,
                token,
              });
            } catch (err) {
              runtime?.error?.(
                danger(`linq: failed to handle message ${msg.id}: ${String(err)}`),
              );
            }
          }

          // Mark chat as read after processing new messages
          if (newMessages.length > 0) {
            try {
              await client.markRead(chatId);
            } catch {
              // non-critical — don't log noise for read receipt failures
            }
          }
        } catch {
          // Individual chat poll failure — continue with other chats
        }
      }

      // Bound the processed set to avoid memory growth
      if (processedMessageIds.size > 10000) {
        const arr = [...processedMessageIds];
        const excess = arr.slice(0, arr.length - 5000);
        for (const id of excess) {
          processedMessageIds.delete(id);
        }
      }
    } catch (err) {
      linqWarn(`poll cycle failed: ${String(err)}`);
      runtime?.error?.(`linq: poll cycle failed: ${String(err)}`);
    }

    await sleep(pollIntervalMs, opts.abortSignal);
  }
}

// ── Inbound message handler ──

async function handleInboundMessage(params: {
  cfg: OpenClawConfig;
  account: ReturnType<typeof resolveLinqAccount>;
  client: LinqClient;
  chat: LinqChat | undefined;
  chatId: string;
  message: LinqMessage;
  fromNumber: string;
  runtime?: RuntimeEnv;
  token: string;
}): Promise<void> {
  const { cfg, account, client, chat, chatId, message, fromNumber, runtime, token } = params;

  const isGroup = chat?.is_group ?? false;
  const senderHandle =
    message.from_handle?.handle ??
    (typeof (message as Record<string, unknown>).from_handle === "string"
      ? (message as Record<string, unknown>).from_handle as string
      : "unknown");
  const senderName = chat?.display_name || senderHandle;

  // Extract text from message parts
  const textParts = (message.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as { value: string }).value);
  const bodyText = textParts.join("\n").trim();

  // Extract media from received message parts (API returns id, url, filename, mime_type, size_bytes)
  const mediaParts = (message.parts ?? []).filter((p) => p.type === "media");
  const firstMedia = mediaParts[0] as { url?: string; mime_type?: string; filename?: string } | undefined;
  const mediaUrl = firstMedia?.url;
  const mediaType = firstMedia?.mime_type;
  const allMediaUrls = mediaParts
    .map((p) => (p as { url?: string }).url)
    .filter((u): u is string => Boolean(u));
  const allMediaTypes = mediaParts
    .map((p) => (p as { mime_type?: string }).mime_type)
    .filter((t): t is string => Boolean(t));

  if (!bodyText && mediaParts.length === 0) {
    return; // No content
  }
  const mediaKind = mediaType ? mediaType.split("/")[0] : undefined;
  const mediaPlaceholder = mediaParts.length > 0
    ? (mediaKind ? `<media:${mediaKind}>` : "<media:attachment>")
    : "";
  const displayBody = bodyText
    ? (mediaParts.length > 0 ? `${bodyText}\n${mediaPlaceholder}` : bodyText)
    : mediaPlaceholder;

  // DM policy / allowFrom gating
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const allowFrom = (account.config.allowFrom ?? []).map((e) => String(e));
  const isAllowed =
    allowFrom.length === 0 ||
    allowFrom.includes("*") ||
    allowFrom.some((entry) => {
      const normalized = entry.toLowerCase().replace(/^linq:/, "");
      const senderNormalized = senderHandle.toLowerCase();
      return normalized === senderNormalized;
    });

  if (!isGroup && !isAllowed) {
    if (dmPolicy === "pairing") {
      const { created, code } = await upsertChannelPairingRequest({
        channel: "linq",
        id: senderHandle,
        meta: { sender: senderHandle, chatId },
      });
      if (created) {
        linqLog(`pairing request sender=${senderHandle}`);
        try {
          await sendMessageLinq(chatId, buildPairingReply({
            channel: "linq",
            idLine: `Your LINQ sender id: ${senderHandle}`,
            code,
          }), {
            apiToken: token,
            fromNumber,
          });
        } catch (err) {
          linqWarn(`pairing reply failed for ${senderHandle}: ${String(err)}`);
        }
      }
    } else {
      linqLog(`blocked sender ${senderHandle} (dmPolicy=${dmPolicy})`);
    }
    return;
  }

  // Resolve agent route
  const route = resolveAgentRoute({
    cfg,
    channel: "linq",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: isGroup ? chatId : senderHandle,
    },
  });

  const fromLabel = formatInboundFromLabel({
    isGroup,
    groupLabel: chat?.display_name ?? undefined,
    groupId: chatId,
    groupFallback: "Group",
    directLabel: senderName,
    directId: senderHandle,
  });

  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = formatInboundEnvelope({
    channel: "LINQ",
    from: fromLabel,
    timestamp: message.sent_at ? Date.parse(message.sent_at) : undefined,
    body: displayBody,
    chatType: isGroup ? "group" : "direct",
    sender: { name: senderName, id: senderHandle },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const linqTo = isGroup ? `linq:group:${chatId}` : `linq:${senderHandle}`;
  const ctxPayload = finalizeInboundContext({
    Body: body,
    RawBody: displayBody,
    CommandBody: displayBody,
    From: isGroup ? `linq:group:${chatId}` : `linq:${senderHandle}`,
    To: linqTo,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    GroupSubject: isGroup ? (chat?.display_name ?? undefined) : undefined,
    SenderName: senderName,
    SenderId: senderHandle,
    Provider: "linq",
    Surface: "linq",
    MessageSid: message.id,
    MessageSidFull: message.id,
    ReplyToId: message.reply_to?.message_id,
    Timestamp: message.sent_at ? Date.parse(message.sent_at) : undefined,
    MediaUrl: mediaUrl,
    MediaType: mediaType,
    MediaUrls: allMediaUrls.length > 0 ? allMediaUrls : undefined,
    MediaTypes: allMediaTypes.length > 0 ? allMediaTypes : undefined,
    WasMentioned: !isGroup,
    CommandAuthorized: isAllowed,
    OriginatingChannel: "linq" as const,
    OriginatingTo: linqTo,
  });

  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: !isGroup
      ? {
          sessionKey: route.mainSessionKey,
          channel: "linq",
          to: senderHandle,
          accountId: route.accountId,
        }
      : undefined,
    onRecordError: (err) => {
      linqWarn(`failed updating session meta: ${String(err)}`);
    },
  });

  const preview = truncateUtf16Safe(body, 200).replace(/\n/g, "\\n");
  linqLog(
    `inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length} media=${allMediaUrls.length} preview="${preview}"`,
  );

  const textLimit = resolveTextChunkLimit(
    cfg,
    "linq",
    account.accountId,
    { fallbackLimit: 4000 },
  );

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "linq",
    accountId: route.accountId,
  });

  const dispatcher = createReplyDispatcher({
    ...prefixOptions,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    deliver: async (payload) => {
      const replyText = typeof payload === "string" ? payload : payload.text ?? "";
      const replyMediaUrl =
        typeof payload === "string" ? undefined : payload.mediaUrl ?? undefined;

      if (!replyText && !replyMediaUrl) return;

      await sendMessageLinq(chatId, replyText, {
        apiToken: token,
        fromNumber,
        mediaUrl: replyMediaUrl,
        preferredService: account.config.preferredService,
      });
    },
    onError: (err, info) => {
      runtime?.error?.(danger(`linq ${info.kind} reply failed: ${String(err)}`));
    },
  });

  await dispatchInboundMessage({
    ctx: ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
      onModelSelected,
    },
  });
}
