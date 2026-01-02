import { chunkText } from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { danger, isVerbose, logVerbose } from "../globals.js";
import { mediaKindFromMime } from "../media/constants.js";
import type { RuntimeEnv } from "../runtime.js";
import { createIMessageRpcClient } from "./client.js";
import { sendMessageIMessage } from "./send.js";
import {
  formatIMessageChatTarget,
  isAllowedIMessageSender,
  normalizeIMessageHandle,
} from "./targets.js";

type IMessageAttachment = {
  original_path?: string | null;
  mime_type?: string | null;
  missing?: boolean | null;
};

type IMessagePayload = {
  id?: number | null;
  chat_id?: number | null;
  sender?: string | null;
  is_from_me?: boolean | null;
  text?: string | null;
  created_at?: string | null;
  attachments?: IMessageAttachment[] | null;
  chat_identifier?: string | null;
  chat_guid?: string | null;
  chat_name?: string | null;
  participants?: string[] | null;
  is_group?: boolean | null;
};

export type MonitorIMessageOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  cliPath?: string;
  dbPath?: string;
  allowFrom?: Array<string | number>;
  includeAttachments?: boolean;
  mediaMaxMb?: number;
  requireMention?: boolean;
};

function resolveRuntime(opts: MonitorIMessageOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

function resolveAllowFrom(opts: MonitorIMessageOpts): string[] {
  const cfg = loadConfig();
  const raw =
    opts.allowFrom ?? cfg.imessage?.allowFrom ?? cfg.routing?.allowFrom ?? [];
  return raw.map((entry) => String(entry).trim()).filter(Boolean);
}

function resolveMentionRegexes(cfg: ReturnType<typeof loadConfig>): RegExp[] {
  return (
    cfg.routing?.groupChat?.mentionPatterns
      ?.map((pattern) => {
        try {
          return new RegExp(pattern, "i");
        } catch {
          return null;
        }
      })
      .filter((val): val is RegExp => Boolean(val)) ?? []
  );
}

function resolveRequireMention(opts: MonitorIMessageOpts): boolean {
  const cfg = loadConfig();
  if (typeof opts.requireMention === "boolean") return opts.requireMention;
  return cfg.routing?.groupChat?.requireMention ?? true;
}

function isMentioned(text: string, regexes: RegExp[]): boolean {
  if (!text) return false;
  const cleaned = text
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
    .toLowerCase();
  return regexes.some((re) => re.test(cleaned));
}

async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  client: Awaited<ReturnType<typeof createIMessageRpcClient>>;
  runtime: RuntimeEnv;
  maxBytes: number;
}) {
  const { replies, target, client, runtime, maxBytes } = params;
  for (const payload of replies) {
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) continue;
    if (mediaList.length === 0) {
      for (const chunk of chunkText(text, 4000)) {
        await sendMessageIMessage(target, chunk, { maxBytes, client });
      }
    } else {
      let first = true;
      for (const url of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageIMessage(target, caption, {
          mediaUrl: url,
          maxBytes,
          client,
        });
      }
    }
    runtime.log?.(`imessage: delivered reply to ${target}`);
  }
}

export async function monitorIMessageProvider(
  opts: MonitorIMessageOpts = {},
): Promise<void> {
  const runtime = resolveRuntime(opts);
  const cfg = loadConfig();
  const allowFrom = resolveAllowFrom(opts);
  const mentionRegexes = resolveMentionRegexes(cfg);
  const requireMention = resolveRequireMention(opts);
  const includeAttachments =
    opts.includeAttachments ?? cfg.imessage?.includeAttachments ?? false;
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.imessage?.mediaMaxMb ?? 16) * 1024 * 1024;

  const handleMessage = async (raw: unknown) => {
    const params = raw as { message?: IMessagePayload | null };
    const message = params?.message ?? null;
    if (!message) return;

    const senderRaw = message.sender ?? "";
    const sender = senderRaw.trim();
    if (!sender) return;
    if (message.is_from_me) return;

    const chatId = message.chat_id ?? undefined;
    const chatGuid = message.chat_guid ?? undefined;
    const chatIdentifier = message.chat_identifier ?? undefined;
    const isGroup = Boolean(message.is_group);
    if (isGroup && !chatId) return;

    if (
      !isAllowedIMessageSender({
        allowFrom,
        sender,
        chatId: chatId ?? undefined,
        chatGuid,
        chatIdentifier,
      })
    ) {
      logVerbose(`Blocked iMessage sender ${sender} (not in allowFrom)`);
      return;
    }

    const messageText = (message.text ?? "").trim();
    const mentioned = isGroup ? isMentioned(messageText, mentionRegexes) : true;
    if (isGroup && requireMention && !mentioned) {
      logVerbose(`imessage: skipping group message (no mention)`);
      return;
    }

    const attachments = includeAttachments ? message.attachments ?? [] : [];
    const firstAttachment = attachments?.find(
      (entry) => entry?.original_path && !entry?.missing,
    );
    const mediaPath = firstAttachment?.original_path ?? undefined;
    const mediaType = firstAttachment?.mime_type ?? undefined;
    const kind = mediaKindFromMime(mediaType ?? undefined);
    const placeholder =
      kind ? `<media:${kind}>` : attachments?.length ? "<media:attachment>" : "";
    const bodyText = messageText || placeholder;
    if (!bodyText) return;

    const chatTarget = formatIMessageChatTarget(chatId);
    const fromLabel = isGroup
      ? `${message.chat_name || "iMessage Group"} id:${chatId ?? "unknown"}`
      : `${normalizeIMessageHandle(sender)} id:${sender}`;
    const createdAt = message.created_at
      ? Date.parse(message.created_at)
      : undefined;
    const body = formatAgentEnvelope({
      surface: "iMessage",
      from: fromLabel,
      timestamp: createdAt,
      body: bodyText,
    });

    const ctxPayload = {
      Body: body,
      From: isGroup ? `group:${chatId}` : `imessage:${sender}`,
      To: chatTarget || `imessage:${sender}`,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? (message.chat_name ?? undefined) : undefined,
      GroupMembers: isGroup
        ? (message.participants ?? []).filter(Boolean).join(", ")
        : undefined,
      SenderName: sender,
      Surface: "imessage",
      MessageSid: message.id ? String(message.id) : undefined,
      Timestamp: createdAt,
      MediaPath: mediaPath,
      MediaType: mediaType,
      MediaUrl: mediaPath,
      WasMentioned: mentioned,
    };

    if (!isGroup) {
      const sessionCfg = cfg.session;
      const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
      const storePath = resolveStorePath(sessionCfg?.store);
      const to = chatTarget || sender;
      if (to) {
        await updateLastRoute({
          storePath,
          sessionKey: mainKey,
          channel: "imessage",
          to,
        });
      }
    }

    if (isVerbose()) {
      const preview = body.slice(0, 200).replace(/\n/g, "\\n");
      logVerbose(
        `imessage inbound: chatId=${chatId ?? "unknown"} from=${ctxPayload.From} len=${body.length} preview="${preview}"`,
      );
    }

    const replyResult = await getReplyFromConfig(ctxPayload, undefined, cfg);
    const replies = replyResult
      ? Array.isArray(replyResult)
        ? replyResult
        : [replyResult]
      : [];
    if (replies.length === 0) return;

    await deliverReplies({
      replies,
      target: ctxPayload.To,
      client,
      runtime,
      maxBytes: mediaMaxBytes,
    });
  };

  const client = await createIMessageRpcClient({
    cliPath: opts.cliPath ?? cfg.imessage?.cliPath,
    dbPath: opts.dbPath ?? cfg.imessage?.dbPath,
    runtime,
    onNotification: (msg) => {
      if (msg.method === "message") {
        void handleMessage(msg.params).catch((err) => {
          runtime.error?.(`imessage: handler failed: ${String(err)}`);
        });
      } else if (msg.method === "error") {
        runtime.error?.(`imessage: watch error ${JSON.stringify(msg.params)}`);
      }
    },
  });

  let subscriptionId: number | null = null;
  const abort = opts.abortSignal;
  const onAbort = () => {
    if (subscriptionId) {
      void client.request("watch.unsubscribe", { subscription: subscriptionId });
    }
    void client.stop();
  };
  abort?.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await client.request<{ subscription?: number }>(
      "watch.subscribe",
      { attachments: includeAttachments },
    );
    subscriptionId = result?.subscription ?? null;
    await client.waitForClose();
  } catch (err) {
    if (abort?.aborted) return;
    runtime.error?.(danger(`imessage: monitor failed: ${String(err)}`));
    throw err;
  } finally {
    abort?.removeEventListener("abort", onAbort);
    await client.stop();
  }
}
