import {
  listDiscordAccountIds,
  type ResolvedDiscordAccount,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
} from "../../discord/accounts.js";
import {
  auditDiscordChannelPermissions,
  collectDiscordAuditChannelIds,
} from "../../discord/audit.js";
import { probeDiscord } from "../../discord/probe.js";
import {
  listGuildChannelsDiscord,
  sendMessageDiscord,
  sendPollDiscord,
} from "../../discord/send.js";
import { resolveNativeCommandsEnabled } from "../../config/commands.js";
import { shouldLogVerbose } from "../../globals.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { getChatChannelMeta } from "../registry.js";
import { DiscordConfigSchema } from "../../config/zod-schema.providers-core.js";
import { discordMessageActions } from "./actions/discord.js";
import { buildChannelConfigSchema } from "./config-schema.js";
import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "./config-helpers.js";
import { resolveDiscordGroupRequireMention } from "./group-mentions.js";
import { formatPairingApproveHint } from "./helpers.js";
import {
  looksLikeDiscordTargetId,
  normalizeDiscordMessagingTarget,
} from "./normalize-target.js";
import { discordOnboardingAdapter } from "./onboarding/discord.js";
import { PAIRING_APPROVED_MESSAGE } from "./pairing-message.js";
import {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "./setup-helpers.js";
import { collectDiscordStatusIssues } from "./status-issues/discord.js";
import type { ChannelPlugin } from "./types.js";

const meta = getChatChannelMeta("discord");

export const discordPlugin: ChannelPlugin<ResolvedDiscordAccount> = {
  id: "discord",
  meta: {
    ...meta,
  },
  onboarding: discordOnboardingAdapter,
  pairing: {
    idLabel: "discordUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(discord|user):/i, ""),
    notifyApproval: async ({ id }) => {
      await sendMessageDiscord(`user:${id}`, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    polls: true,
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.discord"] },
  configSchema: buildChannelConfigSchema(DiscordConfigSchema),
  config: {
    listAccountIds: (cfg) => listDiscordAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDiscordAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDiscordAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "discord",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "discord",
        accountId,
        clearBaseFields: ["token", "name"],
      }),
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveDiscordAccount({ cfg, accountId }).config.dm?.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.discord?.accounts?.[resolvedAccountId]);
      const allowFromPath = useAccountPath
        ? `channels.discord.accounts.${resolvedAccountId}.dm.`
        : "channels.discord.dm.";
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: account.config.dm?.allowFrom ?? [],
        allowFromPath,
        approveHint: formatPairingApproveHint("discord"),
        normalizeEntry: (raw) => raw.replace(/^(discord|user):/i, "").replace(/^<@!?(\d+)>$/, "$1"),
      };
    },
    collectWarnings: ({ cfg, account }) => {
      const warnings: string[] = [];
      const groupPolicy = account.config.groupPolicy ?? "allowlist";
      const guildEntries = account.config.guilds ?? {};
      const guildsConfigured = Object.keys(guildEntries).length > 0;
      const channelAllowlistConfigured = guildsConfigured;

      if (groupPolicy === "open") {
        if (channelAllowlistConfigured) {
          warnings.push(
            `- Discord guilds: groupPolicy="open" allows any channel not explicitly denied to trigger (mention-gated). Set channels.discord.groupPolicy="allowlist" and configure channels.discord.guilds.<id>.channels.`,
          );
        } else {
          warnings.push(
            `- Discord guilds: groupPolicy="open" with no guild/channel allowlist; any channel can trigger (mention-gated). Set channels.discord.groupPolicy="allowlist" and configure channels.discord.guilds.<id>.channels.`,
          );
        }
      }

      const nativeCommandsEnabled = resolveNativeCommandsEnabled({
        providerId: "discord",
        providerSetting: account.config.commands?.native,
        globalSetting: cfg.commands?.native,
      });
      if (nativeCommandsEnabled && guildsConfigured) {
        const hasAnyUserAllowlist = Object.values(guildEntries).some((guild) => {
          if (!guild || typeof guild !== "object") return false;
          if (Array.isArray(guild.users) && guild.users.length > 0) return true;
          const channels = guild.channels;
          if (!channels || typeof channels !== "object") return false;
          return Object.values(channels).some(
            (channel) =>
              Boolean(channel) &&
              typeof channel === "object" &&
              Array.isArray(channel.users) &&
              channel.users.length > 0,
          );
        });

        if (!hasAnyUserAllowlist) {
          warnings.push(
            `- Discord slash commands: no users allowlist configured; this allows any user in allowed guild channels to invoke /… commands. Set channels.discord.guilds.<id>.users (or channels.discord.guilds.<id>.channels.<channel>.users).`,
          );
        }
      }

      return warnings;
    },
  },
  groups: {
    resolveRequireMention: resolveDiscordGroupRequireMention,
  },
  mentions: {
    stripPatterns: () => ["<@!?\\d+>"],
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.discord?.replyToMode ?? "off",
  },
  messaging: {
    normalizeTarget: normalizeDiscordMessagingTarget,
    looksLikeTargetId: looksLikeDiscordTargetId,
    targetHint: "<channelId|user:ID|channel:ID>",
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveDiscordAccount({ cfg, accountId });
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();

      for (const entry of account.config.dm?.allowFrom ?? []) {
        const raw = String(entry).trim();
        if (!raw || raw === "*") continue;
        ids.add(raw);
      }
      for (const id of Object.keys(account.config.dms ?? {})) {
        const trimmed = id.trim();
        if (trimmed) ids.add(trimmed);
      }
      for (const guild of Object.values(account.config.guilds ?? {})) {
        for (const entry of guild.users ?? []) {
          const raw = String(entry).trim();
          if (raw) ids.add(raw);
        }
        for (const channel of Object.values(guild.channels ?? {})) {
          for (const user of channel.users ?? []) {
            const raw = String(user).trim();
            if (raw) ids.add(raw);
          }
        }
      }

      const peers = Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => {
          const mention = raw.match(/^<@!?(\d+)>$/);
          const cleaned = (mention?.[1] ?? raw).replace(/^(discord|user):/i, "").trim();
          if (!/^\d+$/.test(cleaned)) return null;
          return `user:${cleaned}`;
        })
        .filter((id): id is string => Boolean(id))
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
      return peers;
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveDiscordAccount({ cfg, accountId });
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();
      for (const guild of Object.values(account.config.guilds ?? {})) {
        for (const channelId of Object.keys(guild.channels ?? {})) {
          const trimmed = channelId.trim();
          if (trimmed) ids.add(trimmed);
        }
      }

      const groups = Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => {
          const mention = raw.match(/^<#(\d+)>$/);
          const cleaned = (mention?.[1] ?? raw).replace(/^(discord|channel|group):/i, "").trim();
          if (!/^\d+$/.test(cleaned)) return null;
          return `channel:${cleaned}`;
        })
        .filter((id): id is string => Boolean(id))
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
      return groups;
    },
    listGroupsLive: async ({ cfg, accountId, query, limit }) => {
      const account = resolveDiscordAccount({ cfg, accountId });
      const q = query?.trim().toLowerCase() || "";
      const guildIds = Object.keys(account.config.guilds ?? {}).filter((id) => /^\d+$/.test(id));
      const rows: Array<{ kind: "group"; id: string; name?: string; raw?: unknown }> = [];
      for (const guildId of guildIds) {
        const channels = await listGuildChannelsDiscord(guildId, {
          accountId: account.accountId,
        });
        for (const channel of channels) {
          const name = typeof channel.name === "string" ? channel.name : undefined;
          if (q && name && !name.toLowerCase().includes(q)) continue;
          rows.push({
            kind: "group",
            id: `channel:${channel.id}`,
            name: name ?? undefined,
            raw: channel,
          });
        }
      }
      const filtered = q ? rows.filter((row) => row.name?.toLowerCase().includes(q)) : rows;
      const limited = typeof limit === "number" && limit > 0 ? filtered.slice(0, limit) : filtered;
      return limited;
    },
  },
  actions: discordMessageActions,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "discord",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "DISCORD_BOT_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token) {
        return "Discord requires token (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "discord",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "discord",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            discord: {
              ...next.channels?.discord,
              enabled: true,
              ...(input.useEnv ? {} : input.token ? { token: input.token } : {}),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          discord: {
            ...next.channels?.discord,
            enabled: true,
            accounts: {
              ...next.channels?.discord?.accounts,
              [accountId]: {
                ...next.channels?.discord?.accounts?.[accountId],
                enabled: true,
                ...(input.token ? { token: input.token } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: null,
    textChunkLimit: 2000,
    pollMaxOptions: 10,
    sendText: async ({ to, text, accountId, deps, replyToId }) => {
      const send = deps?.sendDiscord ?? sendMessageDiscord;
      const result = await send(to, text, {
        verbose: false,
        replyTo: replyToId ?? undefined,
        accountId: accountId ?? undefined,
      });
      return { channel: "discord", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId }) => {
      const send = deps?.sendDiscord ?? sendMessageDiscord;
      const result = await send(to, text, {
        verbose: false,
        mediaUrl,
        replyTo: replyToId ?? undefined,
        accountId: accountId ?? undefined,
      });
      return { channel: "discord", ...result };
    },
    sendPoll: async ({ to, poll, accountId }) =>
      await sendPollDiscord(to, poll, {
        accountId: accountId ?? undefined,
      }),
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: collectDiscordStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeDiscord(account.token, timeoutMs, { includeApplication: true }),
    auditAccount: async ({ account, timeoutMs, cfg }) => {
      const { channelIds, unresolvedChannels } = collectDiscordAuditChannelIds({
        cfg,
        accountId: account.accountId,
      });
      if (!channelIds.length && unresolvedChannels === 0) return undefined;
      const botToken = account.token?.trim();
      if (!botToken) {
        return {
          ok: unresolvedChannels === 0,
          checkedChannels: 0,
          unresolvedChannels,
          channels: [],
          elapsedMs: 0,
        };
      }
      const audit = await auditDiscordChannelPermissions({
        token: botToken,
        accountId: account.accountId,
        channelIds,
        timeoutMs,
      });
      return { ...audit, unresolvedChannels };
    },
    buildAccountSnapshot: ({ account, runtime, probe, audit }) => {
      const configured = Boolean(account.token?.trim());
      const app = runtime?.application ?? (probe as { application?: unknown })?.application;
      const bot = runtime?.bot ?? (probe as { bot?: unknown })?.bot;
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        tokenSource: account.tokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        application: app ?? undefined,
        bot: bot ?? undefined,
        probe,
        audit,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();
      let discordBotLabel = "";
      try {
        const probe = await probeDiscord(token, 2500, {
          includeApplication: true,
        });
        const username = probe.ok ? probe.bot?.username?.trim() : null;
        if (username) discordBotLabel = ` (@${username})`;
        ctx.setStatus({
          accountId: account.accountId,
          bot: probe.bot,
          application: probe.application,
        });
        const messageContent = probe.application?.intents?.messageContent;
        if (messageContent === "disabled") {
          ctx.log?.warn(
            `[${account.accountId}] Discord Message Content Intent is disabled; bot may not respond to channel messages. Enable it in Discord Dev Portal (Bot → Privileged Gateway Intents) or require mentions.`,
          );
        } else if (messageContent === "limited") {
          ctx.log?.info(
            `[${account.accountId}] Discord Message Content Intent is limited; bots under 100 servers can use it without verification.`,
          );
        }
      } catch (err) {
        if (shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
        }
      }
      ctx.log?.info(`[${account.accountId}] starting provider${discordBotLabel}`);
      // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
      const { monitorDiscordProvider } = await import("../../discord/index.js");
      return monitorDiscordProvider({
        token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
        historyLimit: account.config.historyLimit,
      });
    },
  },
};
