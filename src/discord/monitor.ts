import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  Partials,
} from "discord.js";

import { chunkText } from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { danger, isVerbose, logVerbose } from "../globals.js";
import { getChildLogger } from "../logging.js";
import { detectMime } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { sendMessageDiscord } from "./send.js";
import { normalizeDiscordToken } from "./token.js";

export type MonitorDiscordOpts = {
  token?: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  allowFrom?: Array<string | number>;
  guildAllowFrom?: {
    guilds?: Array<string | number>;
    users?: Array<string | number>;
  };
  requireMention?: boolean;
  mediaMaxMb?: number;
};

type DiscordMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

export async function monitorDiscordProvider(opts: MonitorDiscordOpts = {}) {
  const cfg = loadConfig();
  const token = normalizeDiscordToken(
    opts.token ??
      process.env.DISCORD_BOT_TOKEN ??
      cfg.discord?.token ??
      undefined,
  );
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN or discord.token is required for Discord gateway",
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const allowFrom = opts.allowFrom ?? cfg.discord?.allowFrom;
  const guildAllowFrom = opts.guildAllowFrom ?? cfg.discord?.guildAllowFrom;
  const requireMention =
    opts.requireMention ?? cfg.discord?.requireMention ?? true;
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.discord?.mediaMaxMb ?? 8) * 1024 * 1024;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  const logger = getChildLogger({ module: "discord-auto-reply" });

  client.once(Events.ClientReady, () => {
    runtime.log?.(`discord: logged in as ${client.user?.tag ?? "unknown"}`);
  });

  client.on(Events.Error, (err) => {
    runtime.error?.(danger(`discord client error: ${String(err)}`));
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author?.bot) return;
      if (!message.author) return;

      const isDirectMessage = !message.guild;
      const botId = client.user?.id;
      const wasMentioned =
        !isDirectMessage && Boolean(botId && message.mentions.has(botId));
      if (!isDirectMessage && requireMention) {
        if (botId && !wasMentioned) {
          logger.info(
            {
              channelId: message.channelId,
              reason: "no-mention",
            },
            "discord: skipping guild message",
          );
          return;
        }
      }

      if (!isDirectMessage && guildAllowFrom) {
        const guilds = normalizeDiscordAllowList(guildAllowFrom.guilds, [
          "guild:",
        ]);
        const users = normalizeDiscordAllowList(guildAllowFrom.users, [
          "discord:",
          "user:",
        ]);
        if (guilds || users) {
          const guildId = message.guild?.id ?? "";
          const userId = message.author.id;
          const guildOk =
            !guilds || guilds.allowAll || (guildId && guilds.ids.has(guildId));
          const userOk = !users || users.allowAll || users.ids.has(userId);
          if (!guildOk || !userOk) {
            logVerbose(
              `Blocked discord guild sender ${userId} (guild ${guildId || "unknown"}) not in guildAllowFrom`,
            );
            return;
          }
        }
      }

      if (isDirectMessage && Array.isArray(allowFrom) && allowFrom.length > 0) {
        const allowed = allowFrom
          .map((entry) => String(entry).trim())
          .filter(Boolean);
        const candidate = message.author.id;
        const normalized = new Set(
          allowed
            .filter((entry) => entry !== "*")
            .map((entry) => entry.replace(/^discord:/i, "")),
        );
        const permitted =
          allowed.includes("*") ||
          normalized.has(candidate) ||
          allowed.includes(candidate);
        if (!permitted) {
          logVerbose(
            `Blocked unauthorized discord sender ${candidate} (not in allowFrom)`,
          );
          return;
        }
      }

      const media = await resolveMedia(message, mediaMaxBytes);
      const text =
        message.content?.trim() ??
        media?.placeholder ??
        message.embeds[0]?.description ??
        "";
      if (!text) return;

      const fromLabel = isDirectMessage
        ? buildDirectLabel(message)
        : buildGuildLabel(message);
      const body = formatAgentEnvelope({
        surface: "Discord",
        from: fromLabel,
        timestamp: message.createdTimestamp,
        body: text,
      });

      const ctxPayload = {
        Body: body,
        From: isDirectMessage
          ? `discord:${message.author.id}`
          : `group:${message.channelId}`,
        To: isDirectMessage
          ? `user:${message.author.id}`
          : `channel:${message.channelId}`,
        ChatType: isDirectMessage ? "direct" : "group",
        SenderName: message.member?.displayName ?? message.author.tag,
        GroupSubject:
          !isDirectMessage && "name" in message.channel
            ? message.channel.name
            : undefined,
        Surface: "discord" as const,
        WasMentioned: wasMentioned,
        MessageSid: message.id,
        Timestamp: message.createdTimestamp,
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
      };

      if (isDirectMessage) {
        const sessionCfg = cfg.session;
        const mainKey = (sessionCfg?.mainKey ?? "main").trim() || "main";
        const storePath = resolveStorePath(sessionCfg?.store);
        await updateLastRoute({
          storePath,
          sessionKey: mainKey,
          channel: "discord",
          to: `user:${message.author.id}`,
        });
      }

      if (isVerbose()) {
        const preview = body.slice(0, 200).replace(/\n/g, "\\n");
        logVerbose(
          `discord inbound: channel=${message.channelId} from=${ctxPayload.From} preview="${preview}"`,
        );
      }

      const replyResult = await getReplyFromConfig(
        ctxPayload,
        {
          onReplyStart: () => sendTyping(message),
        },
        cfg,
      );
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];
      if (replies.length === 0) return;

      await deliverReplies({
        replies,
        target: ctxPayload.To,
        token,
        runtime,
      });
    } catch (err) {
      runtime.error?.(danger(`Discord handler failed: ${String(err)}`));
    }
  });

  await client.login(token);

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      void client.destroy();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      opts.abortSignal?.removeEventListener("abort", onAbort);
      client.off(Events.Error, onError);
    };
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    client.on(Events.Error, onError);
  });
}

async function resolveMedia(
  message: import("discord.js").Message,
  maxBytes: number,
): Promise<DiscordMediaInfo | null> {
  const attachment = message.attachments.first();
  if (!attachment) return null;
  const res = await fetch(attachment.url);
  if (!res.ok) {
    throw new Error(
      `Failed to download discord attachment: HTTP ${res.status}`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = await detectMime({
    buffer,
    headerMime: attachment.contentType ?? res.headers.get("content-type"),
    filePath: attachment.name ?? attachment.url,
  });
  const saved = await saveMediaBuffer(buffer, mime, "inbound", maxBytes);
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: inferPlaceholder(attachment),
  };
}

function inferPlaceholder(attachment: import("discord.js").Attachment): string {
  const mime = attachment.contentType ?? "";
  if (mime.startsWith("image/")) return "<media:image>";
  if (mime.startsWith("video/")) return "<media:video>";
  if (mime.startsWith("audio/")) return "<media:audio>";
  return "<media:document>";
}

function buildDirectLabel(message: import("discord.js").Message) {
  const username = message.author.tag;
  return `${username} id:${message.author.id}`;
}

function buildGuildLabel(message: import("discord.js").Message) {
  const channelName =
    "name" in message.channel ? message.channel.name : message.channelId;
  return `${message.guild?.name ?? "Guild"} #${channelName} id:${message.channelId}`;
}

function normalizeDiscordAllowList(
  raw: Array<string | number> | undefined,
  prefixes: string[],
): { allowAll: boolean; ids: Set<string> } | null {
  if (!raw || raw.length === 0) return null;
  const cleaned = raw
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => {
      for (const prefix of prefixes) {
        if (entry.toLowerCase().startsWith(prefix)) {
          return entry.slice(prefix.length);
        }
      }
      return entry;
    });
  const allowAll = cleaned.includes("*");
  const ids = new Set(cleaned.filter((entry) => entry !== "*"));
  return { allowAll, ids };
}

async function sendTyping(message: Message) {
  try {
    const channel = message.channel;
    if (channel.isSendable()) {
      await channel.sendTyping();
    }
  } catch {
    /* ignore */
  }
}

async function deliverReplies({
  replies,
  target,
  token,
  runtime,
}: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  runtime: RuntimeEnv;
}) {
  for (const payload of replies) {
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) continue;
    if (mediaList.length === 0) {
      for (const chunk of chunkText(text, 2000)) {
        await sendMessageDiscord(target, chunk, { token });
      }
    } else {
      let first = true;
      for (const mediaUrl of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageDiscord(target, caption, {
          token,
          mediaUrl,
        });
      }
    }
    runtime.log?.(`discord: delivered reply to ${target}`);
  }
}
