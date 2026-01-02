import {
  ChannelType,
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
  historyLimit?: number;
};

type DiscordMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

type DiscordHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
};

type DiscordAllowList = {
  allowAll: boolean;
  ids: Set<string>;
  names: Set<string>;
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

  const dmConfig = cfg.discord?.dm;
  const guildConfig = cfg.discord?.guild;
  const allowFrom =
    opts.allowFrom ?? dmConfig?.allowFrom ?? cfg.discord?.allowFrom;
  const guildAllowFrom =
    opts.guildAllowFrom ?? guildConfig?.allowFrom ?? cfg.discord?.guildAllowFrom;
  const guildChannels = guildConfig?.channels;
  const requireMention =
    opts.requireMention ??
    guildConfig?.requireMention ??
    cfg.discord?.requireMention ??
    true;
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.discord?.mediaMaxMb ?? 8) * 1024 * 1024;
  const historyLimit = Math.max(
    0,
    opts.historyLimit ??
      guildConfig?.historyLimit ??
      cfg.discord?.historyLimit ??
      20,
  );
  const dmEnabled = dmConfig?.enabled ?? true;

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
  const guildHistories = new Map<string, DiscordHistoryEntry[]>();

  client.once(Events.ClientReady, () => {
    runtime.log?.(`logged in as ${client.user?.tag ?? "unknown"}`);
  });

  client.on(Events.Error, (err) => {
    runtime.error?.(danger(`client error: ${String(err)}`));
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author?.bot) return;
      if (!message.author) return;

      const channelType = message.channel.type;
      const isGroupDm = channelType === ChannelType.GroupDM;
      const isDirectMessage = channelType === ChannelType.DM;
      const isGuildMessage = Boolean(message.guild);
      if (isGroupDm) return;
      if (isDirectMessage && !dmEnabled) return;
      const botId = client.user?.id;
      const wasMentioned =
        !isDirectMessage && Boolean(botId && message.mentions.has(botId));
      const attachment = message.attachments.first();
      const baseText =
        message.content?.trim() ||
        (attachment ? inferPlaceholder(attachment) : "") ||
        message.embeds[0]?.description ||
        "";

      if (isGuildMessage && historyLimit > 0 && baseText) {
        const history = guildHistories.get(message.channelId) ?? [];
        history.push({
          sender: message.member?.displayName ?? message.author.tag,
          body: baseText,
          timestamp: message.createdTimestamp,
          messageId: message.id,
        });
        while (history.length > historyLimit) history.shift();
        guildHistories.set(message.channelId, history);
      }

      if (isGuildMessage && requireMention) {
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

      if (isGuildMessage) {
        const channelAllow = normalizeDiscordAllowList(guildChannels, [
          "channel:",
        ]);
        if (channelAllow) {
          const channelName =
            "name" in message.channel ? message.channel.name : undefined;
          const channelOk = allowListMatches(channelAllow, {
            id: message.channelId,
            name: channelName,
          });
          if (!channelOk) {
            logVerbose(
              `Blocked discord channel ${message.channelId} not in guild.channels`,
            );
            return;
          }
        }
      }

      if (isGuildMessage && guildAllowFrom) {
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
            !guilds ||
            allowListMatches(guilds, {
              id: guildId,
              name: message.guild?.name,
            });
          const userOk =
            !users ||
            allowListMatches(users, {
              id: userId,
              name: message.author.username,
              tag: message.author.tag,
            });
          if (!guildOk || !userOk) {
            logVerbose(
              `Blocked discord guild sender ${userId} (guild ${guildId || "unknown"}) not in guildAllowFrom`,
            );
            return;
          }
        }
      }

      if (isDirectMessage && Array.isArray(allowFrom) && allowFrom.length > 0) {
        const allowList = normalizeDiscordAllowList(allowFrom, [
          "discord:",
          "user:",
        ]);
        const permitted =
          allowList &&
          allowListMatches(allowList, {
            id: message.author.id,
            name: message.author.username,
            tag: message.author.tag,
          });
        if (!permitted) {
          logVerbose(
            `Blocked unauthorized discord sender ${message.author.id} (not in allowFrom)`,
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
        : isGroupDm
          ? buildGroupDmLabel(message)
          : buildGuildLabel(message);
      const groupSubject = (() => {
        if (isDirectMessage) return undefined;
        const channelName =
          "name" in message.channel ? message.channel.name : message.channelId;
        if (!channelName) return undefined;
        return isGuildMessage ? `#${channelName}` : channelName;
      })();
      const textWithId = `${text}\n[discord message id: ${message.id} channel: ${message.channelId}]`;
      let combinedBody = formatAgentEnvelope({
        surface: "Discord",
        from: fromLabel,
        timestamp: message.createdTimestamp,
        body: textWithId,
      });
      let shouldClearHistory = false;
      if (!isDirectMessage) {
        const history =
          historyLimit > 0 ? (guildHistories.get(message.channelId) ?? []) : [];
        const historyWithoutCurrent =
          history.length > 0 ? history.slice(0, -1) : [];
        if (historyWithoutCurrent.length > 0) {
          const historyText = historyWithoutCurrent
            .map((entry) =>
              formatAgentEnvelope({
                surface: "Discord",
                from: fromLabel,
                timestamp: entry.timestamp,
                body: `${entry.sender}: ${entry.body} [id:${entry.messageId ?? "unknown"} channel:${message.channelId}]`,
              }),
            )
            .join("\n");
          combinedBody = `[Chat messages since your last reply - for context]\n${historyText}\n\n[Current message - respond to this]\n${combinedBody}`;
        }
        combinedBody = `${combinedBody}\n[from: ${message.member?.displayName ?? message.author.tag}]`;
        shouldClearHistory = true;
      }

      const ctxPayload = {
        Body: combinedBody,
        From: isDirectMessage
          ? `discord:${message.author.id}`
          : `group:${message.channelId}`,
        To: isDirectMessage
          ? `user:${message.author.id}`
          : `channel:${message.channelId}`,
        ChatType: isDirectMessage ? "direct" : "group",
        SenderName: message.member?.displayName ?? message.author.tag,
        GroupSubject: groupSubject,
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
        const preview = combinedBody.slice(0, 200).replace(/\n/g, "\\n");
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
      if (isGuildMessage && shouldClearHistory && historyLimit > 0) {
        guildHistories.set(message.channelId, []);
      }
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
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

function buildGroupDmLabel(message: import("discord.js").Message) {
  const channelName =
    "name" in message.channel ? message.channel.name : undefined;
  const name = channelName ? ` ${channelName}` : "";
  return `Group DM${name} id:${message.channelId}`;
}

function buildGuildLabel(message: import("discord.js").Message) {
  const channelName =
    "name" in message.channel ? message.channel.name : message.channelId;
  return `${message.guild?.name ?? "Guild"} #${channelName} id:${message.channelId}`;
}

function normalizeDiscordAllowList(
  raw: Array<string | number> | undefined,
  prefixes: string[],
): DiscordAllowList | null {
  if (!raw || raw.length === 0) return null;
  const ids = new Set<string>();
  const names = new Set<string>();
  let allowAll = false;

  for (const rawEntry of raw) {
    let entry = String(rawEntry).trim();
    if (!entry) continue;
    if (entry === "*") {
      allowAll = true;
      continue;
    }
    for (const prefix of prefixes) {
      if (entry.toLowerCase().startsWith(prefix)) {
        entry = entry.slice(prefix.length);
        break;
      }
    }
    const mentionMatch = entry.match(/^<[@#][!]?(\d+)>$/);
    if (mentionMatch?.[1]) {
      ids.add(mentionMatch[1]);
      continue;
    }
    entry = entry.trim();
    if (entry.startsWith("@") || entry.startsWith("#")) {
      entry = entry.slice(1);
    }
    if (/^\d+$/.test(entry)) {
      ids.add(entry);
      continue;
    }
    const normalized = normalizeDiscordName(entry);
    if (normalized) names.add(normalized);
  }

  if (!allowAll && ids.size === 0 && names.size === 0) return null;
  return { allowAll, ids, names };
}

function normalizeDiscordName(value?: string | null) {
  if (!value) return "";
  return value.trim().toLowerCase();
}

function allowListMatches(
  allowList: DiscordAllowList,
  candidates: {
    id?: string;
    name?: string | null;
    tag?: string | null;
  },
) {
  if (allowList.allowAll) return true;
  const { id, name, tag } = candidates;
  if (id && allowList.ids.has(id)) return true;
  const normalizedName = normalizeDiscordName(name);
  if (normalizedName && allowList.names.has(normalizedName)) return true;
  const normalizedTag = normalizeDiscordName(tag);
  if (normalizedTag && allowList.names.has(normalizedTag)) return true;
  return false;
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
    runtime.log?.(`delivered reply to ${target}`);
  }
}
