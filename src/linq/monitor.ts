import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RuntimeEnv } from "../runtime.js";
import type {
  LinqMediaPart,
  LinqMessageReceivedData,
  LinqTextPart,
  LinqWebhookEvent,
} from "./types.js";
import { resolveHumanDelayConfig } from "../agents/identity.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import {
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions,
} from "../auto-reply/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { recordInboundSession } from "../channels/session.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { readSessionUpdatedAt, resolveStorePath } from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { buildPairingReply } from "../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { truncateUtf16Safe } from "../utils.js";
import { resolveLinqAccount } from "./accounts.js";
import { markAsReadLinq, sendMessageLinq, startTypingLinq } from "./send.js";

export type MonitorLinqOpts = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

type MonitorRuntime = {
  info: (msg: string) => void;
  error?: (msg: string) => void;
};

function resolveRuntime(opts: MonitorLinqOpts): MonitorRuntime {
  return {
    info: (msg) => logVerbose(msg),
    error: (msg) => logVerbose(msg),
    ...opts.runtime,
  };
}

function normalizeAllowList(raw?: Array<string | number>): string[] {
  if (!raw || !Array.isArray(raw)) {
    return [];
  }
  return raw.map((v) => String(v).trim()).filter(Boolean);
}

function extractTextContent(parts: Array<{ type: string; value?: string }>): string {
  return parts
    .filter((p): p is LinqTextPart => p.type === "text")
    .map((p) => p.value)
    .join("\n");
}

function extractMediaUrls(
  parts: Array<{ type: string; url?: string; mime_type?: string }>,
): Array<{ url: string; mimeType: string }> {
  return parts
    .filter(
      (p): p is LinqMediaPart & { url: string; mime_type: string } =>
        p.type === "media" && Boolean(p.url) && Boolean(p.mime_type),
    )
    .map((p) => ({ url: p.url, mimeType: p.mime_type }));
}

function verifyWebhookSignature(
  secret: string,
  payload: string,
  timestamp: string,
  signature: string,
): boolean {
  const message = `${timestamp}.${payload}`;
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

function isAllowedLinqSender(allowFrom: string[], sender: string): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalized = sender.replace(/[\s()-]/g, "").toLowerCase();
  return allowFrom.some((entry) => {
    const norm = entry.replace(/[\s()-]/g, "").toLowerCase();
    return norm === normalized;
  });
}

export async function monitorLinqProvider(opts: MonitorLinqOpts = {}): Promise<void> {
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? loadConfig();
  const accountInfo = resolveLinqAccount({ cfg, accountId: opts.accountId });
  const linqCfg = accountInfo.config;
  const token = accountInfo.token;

  if (!token) {
    throw new Error("Linq API token not configured");
  }

  const allowFrom = normalizeAllowList(linqCfg.allowFrom);
  const dmPolicy = linqCfg.dmPolicy ?? "pairing";
  const webhookSecret = linqCfg.webhookSecret?.trim() ?? "";
  const webhookPath = linqCfg.webhookPath?.trim() || "/linq-webhook";
  const webhookHost = linqCfg.webhookHost?.trim() || "0.0.0.0";
  const fromPhone = accountInfo.fromPhone;

  const inboundDebounceMs = resolveInboundDebounceMs({ cfg, channel: "linq" });
  const inboundDebouncer = createInboundDebouncer<{ event: LinqMessageReceivedData }>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const sender = entry.event.from?.trim();
      if (!sender) {
        return null;
      }
      return `linq:${accountInfo.accountId}:${entry.event.chat_id}:${sender}`;
    },
    shouldDebounce: (entry) => {
      const text = extractTextContent(
        entry.event.message.parts as Array<{ type: string; value?: string }>,
      );
      if (!text.trim()) {
        return false;
      }
      return !hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleMessage(last.event);
        return;
      }
      const combinedText = entries
        .map((e) =>
          extractTextContent(e.event.message.parts as Array<{ type: string; value?: string }>),
        )
        .filter(Boolean)
        .join("\n");
      const syntheticEvent: LinqMessageReceivedData = {
        ...last.event,
        message: {
          ...last.event.message,
          parts: [{ type: "text" as const, value: combinedText }],
        },
      };
      await handleMessage(syntheticEvent);
    },
    onError: (err) => {
      runtime.error?.(`linq debounce flush failed: ${String(err)}`);
    },
  });

  async function handleMessage(data: LinqMessageReceivedData) {
    const sender = data.from?.trim();
    if (!sender) {
      return;
    }
    if (data.is_from_me) {
      return;
    }

    // Filter: only process messages sent to this account's phone number.
    if (fromPhone && data.recipient_phone !== fromPhone) {
      logVerbose(`linq: skipping message to ${data.recipient_phone} (not ${fromPhone})`);
      return;
    }

    const chatId = data.chat_id;
    const text = extractTextContent(data.message.parts as Array<{ type: string; value?: string }>);
    const media = extractMediaUrls(
      data.message.parts as Array<{ type: string; url?: string; mime_type?: string }>,
    );

    if (!text.trim() && media.length === 0) {
      return;
    }

    // Send read receipt and typing indicator immediately (fire-and-forget).
    markAsReadLinq(chatId, token).catch(() => {});
    startTypingLinq(chatId, token).catch(() => {});

    const storeAllowFrom = await readChannelAllowFromStore("linq").catch(() => []);
    const effectiveDmAllowFrom = Array.from(new Set([...allowFrom, ...storeAllowFrom]))
      .map((v) => String(v).trim())
      .filter(Boolean);

    const dmHasWildcard = effectiveDmAllowFrom.includes("*");
    const dmAuthorized =
      dmPolicy === "open"
        ? true
        : dmHasWildcard ||
          (effectiveDmAllowFrom.length > 0 && isAllowedLinqSender(effectiveDmAllowFrom, sender));

    if (dmPolicy === "disabled") {
      return;
    }
    if (!dmAuthorized) {
      if (dmPolicy === "pairing") {
        const { code, created } = await upsertChannelPairingRequest({
          channel: "linq",
          id: sender,
          meta: { sender, chatId },
        });
        if (created) {
          logVerbose(`linq pairing request sender=${sender}`);
          try {
            await sendMessageLinq(
              chatId,
              buildPairingReply({
                channel: "linq",
                idLine: `Your phone number: ${sender}`,
                code,
              }),
              { token, accountId: accountInfo.accountId },
            );
          } catch (err) {
            logVerbose(`linq pairing reply failed for ${sender}: ${String(err)}`);
          }
        }
      } else {
        logVerbose(`Blocked linq sender ${sender} (dmPolicy=${dmPolicy})`);
      }
      return;
    }

    const route = resolveAgentRoute({
      cfg,
      channel: "linq",
      accountId: accountInfo.accountId,
      peer: { kind: "direct", id: sender },
    });
    const bodyText = text.trim() || (media.length > 0 ? "<media:image>" : "");
    if (!bodyText) {
      return;
    }

    const replyContext = data.message.reply_to ? { id: data.message.reply_to.message_id } : null;
    const createdAt = data.received_at ? Date.parse(data.received_at) : undefined;

    const fromLabel = formatInboundFromLabel({
      isGroup: false,
      directLabel: sender,
      directId: sender,
    });
    const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
    const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
    const previousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });

    const replySuffix = replyContext?.id ? `\n\n[Replying to message ${replyContext.id}]` : "";
    const body = formatInboundEnvelope({
      channel: "Linq iMessage",
      from: fromLabel,
      timestamp: createdAt,
      body: `${bodyText}${replySuffix}`,
      chatType: "direct",
      sender: { name: sender, id: sender },
      previousTimestamp,
      envelope: envelopeOptions,
    });

    const linqTo = chatId;
    const ctxPayload = finalizeInboundContext({
      Body: body,
      BodyForAgent: bodyText,
      RawBody: bodyText,
      CommandBody: bodyText,
      From: `linq:${sender}`,
      To: linqTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: "direct",
      ConversationLabel: fromLabel,
      SenderName: sender,
      SenderId: sender,
      Provider: "linq",
      Surface: "linq",
      MessageSid: data.message.id,
      ReplyToId: replyContext?.id,
      Timestamp: createdAt,
      MediaUrl: media[0]?.url,
      MediaType: media[0]?.mimeType,
      MediaUrls: media.length > 0 ? media.map((m) => m.url) : undefined,
      MediaTypes: media.length > 0 ? media.map((m) => m.mimeType) : undefined,
      WasMentioned: true,
      CommandAuthorized: dmAuthorized,
      OriginatingChannel: "linq" as const,
      OriginatingTo: linqTo,
    });

    await recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: route.mainSessionKey,
        channel: "linq",
        to: linqTo,
        accountId: route.accountId,
      },
      onRecordError: (err) => {
        logVerbose(`linq: failed updating session meta: ${String(err)}`);
      },
    });

    if (shouldLogVerbose()) {
      const preview = truncateUtf16Safe(body, 200).replace(/\n/g, "\\n");
      logVerbose(
        `linq inbound: chatId=${chatId} from=${sender} len=${body.length} preview="${preview}"`,
      );
    }

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
        const replyText = typeof payload === "string" ? payload : (payload.text ?? "");
        if (replyText) {
          await sendMessageLinq(chatId, replyText, {
            token,
            accountId: accountInfo.accountId,
          });
        }
      },
      onError: (err, info) => {
        runtime.error?.(danger(`linq ${info.kind} reply failed: ${String(err)}`));
      },
    });

    await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        disableBlockStreaming:
          typeof linqCfg.blockStreaming === "boolean" ? !linqCfg.blockStreaming : undefined,
        onModelSelected,
      },
    });
  }

  // --- HTTP webhook server ---
  const port = linqCfg.webhookUrl ? new URL(linqCfg.webhookUrl).port || "0" : "0";

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method !== "POST" || !url.pathname.startsWith(webhookPath)) {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    const maxPayloadBytes = 1024 * 1024; // 1MB limit
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxPayloadBytes) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");

    // Verify webhook signature if a secret is configured.
    if (webhookSecret) {
      const timestamp = req.headers["x-webhook-timestamp"] as string | undefined;
      const signature = req.headers["x-webhook-signature"] as string | undefined;
      if (
        !timestamp ||
        !signature ||
        !verifyWebhookSignature(webhookSecret, rawBody, timestamp, signature)
      ) {
        res.writeHead(401);
        res.end("invalid signature");
        return;
      }
      // Reject stale webhooks (>5 minutes).
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (age > 300) {
        res.writeHead(401);
        res.end("stale timestamp");
        return;
      }
    }

    // Acknowledge immediately.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));

    // Parse and dispatch.
    try {
      const event = JSON.parse(rawBody) as LinqWebhookEvent;
      if (event.event_type === "message.received") {
        const data = event.data as LinqMessageReceivedData;
        await inboundDebouncer.enqueue({ event: data });
      }
    } catch (err) {
      runtime.error?.(`linq webhook parse error: ${String(err)}`);
    }
  });

  const listenPort = Number(port) || 0;
  await new Promise<void>((resolve, reject) => {
    server.listen(listenPort, webhookHost, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" ? addr?.port : listenPort;
      runtime.info(`linq: webhook listener started on ${webhookHost}:${boundPort}${webhookPath}`);
      resolve();
    });
    server.on("error", reject);
  });

  // Handle shutdown.
  const abort = opts.abortSignal;
  if (abort) {
    const onAbort = () => {
      server.close();
    };
    abort.addEventListener("abort", onAbort, { once: true });
    await new Promise<void>((resolve) => {
      server.on("close", resolve);
      if (abort.aborted) {
        server.close();
      }
    });
    abort.removeEventListener("abort", onAbort);
  } else {
    await new Promise<void>((resolve) => {
      server.on("close", resolve);
    });
  }
}
