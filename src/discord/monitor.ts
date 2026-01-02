import {
  type CommandInteractionOption,
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
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { danger, isVerbose, logVerbose } from "../globals.js";
import { getChildLogger } from "../logging.js";
import { detectMime } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { sendMessageDiscord } from "./send.js";
import { normalizeDiscordToken } from "./token.js";
import type { DiscordSlashCommandConfig } from "../config/config.js";

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
  slashCommand?: DiscordSlashCommandConfig;
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
  const slashCommand = resolveSlashCommandConfig(
    opts.slashCommand ?? cfg.discord?.slashCommand,
  );
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.discord?.mediaMaxMb ?? 8) * 1024 * 1024;
  const historyLimit = Math.max(
    0,
    opts.historyLimit ?? cfg.discord?.historyLimit ?? 20,
  );

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

      const isDirectMessage = !message.guild;
      const botId = client.user?.id;
      const wasMentioned =
        !isDirectMessage && Boolean(botId && message.mentions.has(botId));
      const attachment = message.attachments.first();
      const baseText =
        message.content?.trim() ||
        (attachment ? inferPlaceholder(attachment) : "") ||
        message.embeds[0]?.description ||
        "";

      if (!isDirectMessage && historyLimit > 0 && baseText) {
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
      if (!isDirectMessage && shouldClearHistory && historyLimit > 0) {
        guildHistories.set(message.channelId, []);
      }
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!slashCommand.enabled) return;
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== slashCommand.name) return;
      if (interaction.user?.bot) return;

      const prompt = resolveSlashPrompt(interaction.options.data);
      if (!prompt) {
        await interaction.reply({
          content: "Message required.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: slashCommand.ephemeral });

      const userId = interaction.user.id;
      const ctxPayload = {
        Body: prompt,
        From: `discord:${userId}`,
        To: `slash:${userId}`,
        ChatType: "direct",
        SenderName: interaction.user.username,
        Surface: "discord" as const,
        WasMentioned: true,
        MessageSid: interaction.id,
        Timestamp: interaction.createdTimestamp,
        SessionKey: `${slashCommand.sessionPrefix}:${userId}`,
      };

      const replyResult = await getReplyFromConfig(ctxPayload, undefined, cfg);
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];

      await deliverSlashReplies({
        replies,
        interaction,
        ephemeral: slashCommand.ephemeral,
      });
    } catch (err) {
      runtime.error?.(danger(`slash handler failed: ${String(err)}`));
      if (interaction.isRepliable()) {
        const content = "Sorry, something went wrong handling that command.";
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content, ephemeral: true });
        } else {
          await interaction.reply({ content, ephemeral: true });
        }
      }
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

function resolveSlashCommandConfig(
  raw: DiscordSlashCommandConfig | undefined,
): Required<DiscordSlashCommandConfig> {
  return {
    enabled: raw ? raw.enabled !== false : false,
    name: raw?.name?.trim() || "clawd",
    sessionPrefix: raw?.sessionPrefix?.trim() || "discord:slash",
    ephemeral: raw?.ephemeral !== false,
  };
}

function resolveSlashPrompt(
  options: readonly CommandInteractionOption[],
): string | undefined {
  const direct = findFirstStringOption(options);
  if (direct) return direct;
  return undefined;
}

function findFirstStringOption(
  options: readonly CommandInteractionOption[],
): string | undefined {
  for (const option of options) {
    if (typeof option.value === "string") {
      const trimmed = option.value.trim();
      if (trimmed) return trimmed;
    }
    if (option.options && option.options.length > 0) {
      const nested = findFirstStringOption(option.options);
      if (nested) return nested;
    }
  }
  return undefined;
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

async function deliverSlashReplies({
  replies,
  interaction,
  ephemeral,
}: {
  replies: ReplyPayload[];
  interaction: import("discord.js").ChatInputCommandInteraction;
  ephemeral: boolean;
}) {
  const messages: string[] = [];
  for (const payload of replies) {
    const textRaw = payload.text?.trim() ?? "";
    const text =
      textRaw && textRaw !== SILENT_REPLY_TOKEN ? textRaw : undefined;
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const combined = [
      text ?? "",
      ...mediaList.map((url) => url.trim()).filter(Boolean),
    ]
      .filter(Boolean)
      .join("\n");
    if (!combined) continue;
    for (const chunk of chunkText(combined, 2000)) {
      messages.push(chunk);
    }
  }

  if (messages.length === 0) {
    await interaction.editReply({
      content: "No response was generated for that command.",
    });
    return;
  }

  const [first, ...rest] = messages;
  await interaction.editReply({ content: first });
  for (const message of rest) {
    await interaction.followUp({ content: message, ephemeral });
  }
}
