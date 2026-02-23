import {
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
} from "../config/group-policy.js";
import { resolveDiscordAccount } from "../discord/accounts.js";
import { resolveIMessageAccount } from "../imessage/accounts.js";
import { requireActivePluginRegistry } from "../plugins/runtime.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { resolveSignalAccount } from "../signal/accounts.js";
import { resolveSlackAccount, resolveSlackReplyToMode } from "../slack/accounts.js";
import { buildSlackThreadingToolContext } from "../slack/threading-tool-context.js";
import { resolveTelegramAccount } from "../telegram/accounts.js";
import { escapeRegExp, normalizeE164 } from "../utils.js";
import { resolveWhatsAppAccount } from "../web/accounts.js";
import { normalizeWhatsAppTarget } from "../whatsapp/normalize.js";
import {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
  resolveGoogleChatGroupRequireMention,
  resolveGoogleChatGroupToolPolicy,
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
  resolveSlackGroupRequireMention,
  resolveSlackGroupToolPolicy,
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./plugins/group-mentions.js";
import { normalizeSignalMessagingTarget } from "./plugins/normalize/signal.js";
import type {
  ChannelCapabilities,
  ChannelCommandAdapter,
  ChannelConfigAdapter,
  ChannelElevatedAdapter,
  ChannelGroupAdapter,
  ChannelId,
  ChannelAgentPromptAdapter,
  ChannelMentionAdapter,
  ChannelPlugin,
  ChannelThreadingContext,
  ChannelThreadingAdapter,
  ChannelThreadingToolContext,
} from "./plugins/types.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId, getChatChannelMeta } from "./registry.js";

export type ChannelDock = {
  id: ChannelId;
  capabilities: ChannelCapabilities;
  commands?: ChannelCommandAdapter;
  outbound?: {
    textChunkLimit?: number;
  };
  streaming?: ChannelDockStreaming;
  elevated?: ChannelElevatedAdapter;
  config?: Pick<
    ChannelConfigAdapter<unknown>,
    "resolveAllowFrom" | "formatAllowFrom" | "resolveDefaultTo"
  >;
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  threading?: ChannelThreadingAdapter;
  agentPrompt?: ChannelAgentPromptAdapter;
};

type ChannelDockStreaming = {
  blockStreamingCoalesceDefaults?: {
    minChars?: number;
    idleMs?: number;
  };
};

const formatLower = (allowFrom: Array<string | number>) =>
  allowFrom
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());

const stringifyAllowFrom = (allowFrom: Array<string | number>) =>
  allowFrom.map((entry) => String(entry));

const trimAllowFromEntries = (allowFrom: Array<string | number>) =>
  allowFrom.map((entry) => String(entry).trim()).filter(Boolean);

const DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000 = { textChunkLimit: 4000 };

const DEFAULT_BLOCK_STREAMING_COALESCE = {
  blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
};

function formatAllowFromWithReplacements(
  allowFrom: Array<string | number>,
  replacements: RegExp[],
): string[] {
  return trimAllowFromEntries(allowFrom).map((entry) => {
    let normalized = entry;
    for (const replacement of replacements) {
      normalized = normalized.replace(replacement, "");
    }
    return normalized.toLowerCase();
  });
}

const formatDiscordAllowFrom = (allowFrom: Array<string | number>) =>
  allowFrom
    .map((entry) =>
      String(entry)
        .trim()
        .replace(/^<@!?/, "")
        .replace(/>$/, "")
        .replace(/^discord:/i, "")
        .replace(/^user:/i, "")
        .replace(/^pk:/i, "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);

function resolveDirectOrGroupChannelId(context: ChannelThreadingContext): string | undefined {
  const isDirect = context.ChatType?.toLowerCase() === "direct";
  return (isDirect ? (context.From ?? context.To) : context.To)?.trim() || undefined;
}

function buildSignalThreadToolContext(params: {
  context: ChannelThreadingContext;
  hasRepliedRef: ChannelThreadingToolContext["hasRepliedRef"];
}): ChannelThreadingToolContext {
  const currentChannelIdRaw = resolveDirectOrGroupChannelId(params.context);
  const currentChannelId = currentChannelIdRaw
    ? (normalizeSignalMessagingTarget(currentChannelIdRaw) ?? currentChannelIdRaw.trim())
    : undefined;
  return {
    currentChannelId,
    currentThreadTs: params.context.ReplyToId,
    hasRepliedRef: params.hasRepliedRef,
  };
}

function buildIMessageThreadToolContext(params: {
  context: ChannelThreadingContext;
  hasRepliedRef: ChannelThreadingToolContext["hasRepliedRef"];
}): ChannelThreadingToolContext {
  return {
    currentChannelId: resolveDirectOrGroupChannelId(params.context),
    currentThreadTs: params.context.ReplyToId,
    hasRepliedRef: params.hasRepliedRef,
  };
}

function buildThreadToolContextFromMessageThreadOrReply(params: {
  context: ChannelThreadingContext;
  hasRepliedRef: ChannelThreadingToolContext["hasRepliedRef"];
}): ChannelThreadingToolContext {
  const threadId = params.context.MessageThreadId ?? params.context.ReplyToId;
  return {
    currentChannelId: params.context.To?.trim() || undefined,
    currentThreadTs: threadId != null ? String(threadId) : undefined,
    hasRepliedRef: params.hasRepliedRef,
  };
}

function resolveCaseInsensitiveAccount<T>(
  accounts: Record<string, T> | undefined,
  accountId?: string | null,
): T | undefined {
  if (!accounts) {
    return undefined;
  }
  const normalized = normalizeAccountId(accountId);
  return (
    accounts[normalized] ??
    accounts[
      Object.keys(accounts).find((key) => key.toLowerCase() === normalized.toLowerCase()) ?? ""
    ]
  );
}

function resolveDefaultToCaseInsensitiveAccount(params: {
  channel?:
    | {
        accounts?: Record<string, { defaultTo?: string }>;
        defaultTo?: string;
      }
    | undefined;
  accountId?: string | null;
}): string | undefined {
  const account = resolveCaseInsensitiveAccount(params.channel?.accounts, params.accountId);
  return (account?.defaultTo ?? params.channel?.defaultTo)?.trim() || undefined;
}

function resolveChannelDefaultTo(
  channel:
    | {
        accounts?: Record<string, { defaultTo?: string }>;
        defaultTo?: string;
      }
    | undefined,
  accountId?: string | null,
): string | undefined {
  return resolveDefaultToCaseInsensitiveAccount({ channel, accountId });
}

type CaseInsensitiveDefaultToChannel = {
  accounts?: Record<string, { defaultTo?: string }>;
  defaultTo?: string;
};

type CaseInsensitiveDefaultToChannels = Partial<
  Record<"irc" | "googlechat", CaseInsensitiveDefaultToChannel>
>;

function resolveNamedChannelDefaultTo(params: {
  channels?: CaseInsensitiveDefaultToChannels;
  channelId: keyof CaseInsensitiveDefaultToChannels;
  accountId?: string | null;
}): string | undefined {
  return resolveChannelDefaultTo(params.channels?.[params.channelId], params.accountId);
}
// Channel docks: lightweight channel metadata/behavior for shared code paths.
//
// Rules:
// - keep this module *light* (no monitors, probes, puppeteer/web login, etc)
// - OK: config readers, allowFrom formatting, mention stripping patterns, threading defaults
// - shared code should import from here (and from `src/channels/registry.ts`), not from the plugins registry
//
// Adding a channel:
// - add a new entry to `DOCKS`
// - keep it cheap; push heavy logic into `src/channels/plugins/<id>.ts` or channel modules
const DOCKS: Record<ChatChannelId, ChannelDock> = {
  telegram: {
    id: "telegram",
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      nativeCommands: true,
      blockStreaming: true,
    },
    outbound: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000,
    config: {
      resolveAllowFrom: ({ cfg, accountId }) =>
        stringifyAllowFrom(resolveTelegramAccount({ cfg, accountId }).config.allowFrom ?? []),
      formatAllowFrom: ({ allowFrom }) =>
        trimAllowFromEntries(allowFrom)
          .map((entry) => entry.replace(/^(telegram|tg):/i, ""))
          .map((entry) => entry.toLowerCase()),
      resolveDefaultTo: ({ cfg, accountId }) => {
        const val = resolveTelegramAccount({ cfg, accountId }).config.defaultTo;
        return val != null ? String(val) : undefined;
      },
    },
    groups: {
      resolveRequireMention: resolveTelegramGroupRequireMention,
      resolveToolPolicy: resolveTelegramGroupToolPolicy,
    },
    threading: {
      resolveReplyToMode: ({ cfg }) => cfg.channels?.telegram?.replyToMode ?? "off",
      buildToolContext: ({ context, hasRepliedRef }) => {
        // Telegram auto-threading should only use actual thread/topic IDs.
        // ReplyToId is a message ID and causes invalid message_thread_id in DMs.
        const threadId = context.MessageThreadId;
        const rawCurrentMessageId = context.CurrentMessageId;
        const currentMessageId =
          typeof rawCurrentMessageId === "number"
            ? rawCurrentMessageId
            : rawCurrentMessageId?.trim() || undefined;
        return {
          currentChannelId: context.To?.trim() || undefined,
          currentThreadTs: threadId != null ? String(threadId) : undefined,
          currentMessageId,
          hasRepliedRef,
        };
      },
    },
  },
  whatsapp: {
    id: "whatsapp",
    capabilities: {
      chatTypes: ["direct", "group"],
      polls: true,
      reactions: true,
      media: true,
    },
    commands: {
      enforceOwnerForCommands: true,
      skipWhenConfigEmpty: true,
    },
    outbound: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000,
    config: {
      resolveAllowFrom: ({ cfg, accountId }) =>
        resolveWhatsAppAccount({ cfg, accountId }).allowFrom ?? [],
      formatAllowFrom: ({ allowFrom }) =>
        allowFrom
          .map((entry) => String(entry).trim())
          .filter((entry): entry is string => Boolean(entry))
          .map((entry) => (entry === "*" ? entry : normalizeWhatsAppTarget(entry)))
          .filter((entry): entry is string => Boolean(entry)),
      resolveDefaultTo: ({ cfg, accountId }) => {
        const root = cfg.channels?.whatsapp;
        const normalized = normalizeAccountId(accountId);
        const account = root?.accounts?.[normalized];
        return (account?.defaultTo ?? root?.defaultTo)?.trim() || undefined;
      },
    },
    groups: {
      resolveRequireMention: resolveWhatsAppGroupRequireMention,
      resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
      resolveGroupIntroHint: () =>
        "WhatsApp IDs: SenderId is the participant JID (group participant id).",
    },
    mentions: {
      stripPatterns: ({ ctx }) => {
        const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/, "");
        if (!selfE164) {
          return [];
        }
        const escaped = escapeRegExp(selfE164);
        return [escaped, `@${escaped}`];
      },
    },
    threading: {
      buildToolContext: ({ context, hasRepliedRef }) => {
        const channelId = context.From?.trim() || context.To?.trim() || undefined;
        return {
          currentChannelId: channelId,
          currentThreadTs: context.ReplyToId,
          hasRepliedRef,
        };
      },
    },
  },
  discord: {
    id: "discord",
    capabilities: {
      chatTypes: ["direct", "channel", "thread"],
      polls: true,
      reactions: true,
      media: true,
      nativeCommands: true,
      threads: true,
    },
    outbound: { textChunkLimit: 2000 },
    streaming: DEFAULT_BLOCK_STREAMING_COALESCE,
    elevated: {
      allowFromFallback: ({ cfg }) =>
        cfg.channels?.discord?.allowFrom ?? cfg.channels?.discord?.dm?.allowFrom,
    },
    config: {
      resolveAllowFrom: ({ cfg, accountId }) => {
        const account = resolveDiscordAccount({ cfg, accountId });
        return (account.config.allowFrom ?? account.config.dm?.allowFrom ?? []).map((entry) =>
          String(entry),
        );
      },
      formatAllowFrom: ({ allowFrom }) => formatDiscordAllowFrom(allowFrom),
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveDiscordAccount({ cfg, accountId }).config.defaultTo?.trim() || undefined,
    },
    groups: {
      resolveRequireMention: resolveDiscordGroupRequireMention,
      resolveToolPolicy: resolveDiscordGroupToolPolicy,
    },
    mentions: {
      stripPatterns: () => ["<@!?\\d+>"],
    },
    threading: {
      resolveReplyToMode: ({ cfg }) => cfg.channels?.discord?.replyToMode ?? "off",
      buildToolContext: ({ context, hasRepliedRef }) => ({
        currentChannelId: context.To?.trim() || undefined,
        currentThreadTs: context.ReplyToId,
        hasRepliedRef,
      }),
    },
  },
  irc: {
    id: "irc",
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      blockStreaming: true,
    },
    outbound: { textChunkLimit: 350 },
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 300, idleMs: 1000 },
    },
    config: {
      resolveAllowFrom: ({ cfg, accountId }) => {
        const channel = cfg.channels?.irc;
        const account = resolveCaseInsensitiveAccount(channel?.accounts, accountId);
        return (account?.allowFrom ?? channel?.allowFrom ?? []).map((entry) => String(entry));
      },
      formatAllowFrom: ({ allowFrom }) =>
        formatAllowFromWithReplacements(allowFrom, [/^irc:/i, /^user:/i]),
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveNamedChannelDefaultTo({
          channels: cfg.channels as CaseInsensitiveDefaultToChannels | undefined,
          channelId: "irc",
          accountId,
        }),
    },
    groups: {
      resolveRequireMention: ({ cfg, accountId, groupId }) => {
        if (!groupId) {
          return true;
        }
        return resolveChannelGroupRequireMention({
          cfg,
          channel: "irc",
          groupId,
          accountId,
          groupIdCaseInsensitive: true,
        });
      },
      resolveToolPolicy: ({ cfg, accountId, groupId, senderId, senderName, senderUsername }) => {
        if (!groupId) {
          return undefined;
        }
        // IRC supports per-channel tool policies. Prefer the shared resolver so
        // toolsBySender is honored consistently across surfaces.
        return resolveChannelGroupToolsPolicy({
          cfg,
          channel: "irc",
          groupId,
          accountId,
          groupIdCaseInsensitive: true,
          senderId,
          senderName,
          senderUsername,
        });
      },
    },
  },
  googlechat: {
    id: "googlechat",
    capabilities: {
      chatTypes: ["direct", "group", "thread"],
      reactions: true,
      media: true,
      threads: true,
      blockStreaming: true,
    },
    outbound: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000,
    config: {
      resolveAllowFrom: ({ cfg, accountId }) => {
        const channel = cfg.channels?.googlechat as
          | {
              accounts?: Record<string, { dm?: { allowFrom?: Array<string | number> } }>;
              dm?: { allowFrom?: Array<string | number> };
            }
          | undefined;
        const account = resolveCaseInsensitiveAccount(channel?.accounts, accountId);
        return (account?.dm?.allowFrom ?? channel?.dm?.allowFrom ?? []).map((entry) =>
          String(entry),
        );
      },
      formatAllowFrom: ({ allowFrom }) =>
        formatAllowFromWithReplacements(allowFrom, [
          /^(googlechat|google-chat|gchat):/i,
          /^user:/i,
          /^users\//i,
        ]),
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveNamedChannelDefaultTo({
          channels: cfg.channels as CaseInsensitiveDefaultToChannels | undefined,
          channelId: "googlechat",
          accountId,
        }),
    },
    groups: {
      resolveRequireMention: resolveGoogleChatGroupRequireMention,
      resolveToolPolicy: resolveGoogleChatGroupToolPolicy,
    },
    threading: {
      resolveReplyToMode: ({ cfg }) => cfg.channels?.googlechat?.replyToMode ?? "off",
      buildToolContext: ({ context, hasRepliedRef }) =>
        buildThreadToolContextFromMessageThreadOrReply({ context, hasRepliedRef }),
    },
  },
  slack: {
    id: "slack",
    capabilities: {
      chatTypes: ["direct", "channel", "thread"],
      reactions: true,
      media: true,
      nativeCommands: true,
      threads: true,
    },
    outbound: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000,
    streaming: DEFAULT_BLOCK_STREAMING_COALESCE,
    config: {
      resolveAllowFrom: ({ cfg, accountId }) => {
        const account = resolveSlackAccount({ cfg, accountId });
        return (account.config.allowFrom ?? account.dm?.allowFrom ?? []).map((entry) =>
          String(entry),
        );
      },
      formatAllowFrom: ({ allowFrom }) => formatLower(allowFrom),
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveSlackAccount({ cfg, accountId }).config.defaultTo?.trim() || undefined,
    },
    groups: {
      resolveRequireMention: resolveSlackGroupRequireMention,
      resolveToolPolicy: resolveSlackGroupToolPolicy,
    },
    mentions: {
      stripPatterns: () => ["<@[^>]+>"],
    },
    threading: {
      resolveReplyToMode: ({ cfg, accountId, chatType }) =>
        resolveSlackReplyToMode(resolveSlackAccount({ cfg, accountId }), chatType),
      allowExplicitReplyTagsWhenOff: false,
      buildToolContext: (params) => buildSlackThreadingToolContext(params),
    },
  },
  signal: {
    id: "signal",
    capabilities: {
      chatTypes: ["direct", "group"],
      reactions: true,
      media: true,
    },
    outbound: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000,
    streaming: DEFAULT_BLOCK_STREAMING_COALESCE,
    config: {
      resolveAllowFrom: ({ cfg, accountId }) =>
        stringifyAllowFrom(resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? []),
      formatAllowFrom: ({ allowFrom }) =>
        trimAllowFromEntries(allowFrom)
          .map((entry) => (entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))))
          .filter(Boolean),
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveSignalAccount({ cfg, accountId }).config.defaultTo?.trim() || undefined,
    },
    threading: {
      buildToolContext: ({ context, hasRepliedRef }) =>
        buildSignalThreadToolContext({ context, hasRepliedRef }),
    },
  },
  imessage: {
    id: "imessage",
    capabilities: {
      chatTypes: ["direct", "group"],
      reactions: true,
      media: true,
    },
    outbound: DEFAULT_OUTBOUND_TEXT_CHUNK_LIMIT_4000,
    config: {
      resolveAllowFrom: ({ cfg, accountId }) =>
        (resolveIMessageAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
          String(entry),
        ),
      formatAllowFrom: ({ allowFrom }) =>
        allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveIMessageAccount({ cfg, accountId }).config.defaultTo?.trim() || undefined,
    },
    groups: {
      resolveRequireMention: resolveIMessageGroupRequireMention,
      resolveToolPolicy: resolveIMessageGroupToolPolicy,
    },
    threading: {
      buildToolContext: ({ context, hasRepliedRef }) =>
        buildIMessageThreadToolContext({ context, hasRepliedRef }),
    },
  },
};

function buildDockFromPlugin(plugin: ChannelPlugin): ChannelDock {
  return {
    id: plugin.id,
    capabilities: plugin.capabilities,
    commands: plugin.commands,
    outbound: plugin.outbound?.textChunkLimit
      ? { textChunkLimit: plugin.outbound.textChunkLimit }
      : undefined,
    streaming: plugin.streaming
      ? { blockStreamingCoalesceDefaults: plugin.streaming.blockStreamingCoalesceDefaults }
      : undefined,
    elevated: plugin.elevated,
    config: plugin.config
      ? {
          resolveAllowFrom: plugin.config.resolveAllowFrom,
          formatAllowFrom: plugin.config.formatAllowFrom,
          resolveDefaultTo: plugin.config.resolveDefaultTo,
        }
      : undefined,
    groups: plugin.groups,
    mentions: plugin.mentions,
    threading: plugin.threading,
    agentPrompt: plugin.agentPrompt,
  };
}

function listPluginDockEntries(): Array<{ id: ChannelId; dock: ChannelDock; order?: number }> {
  const registry = requireActivePluginRegistry();
  const entries: Array<{ id: ChannelId; dock: ChannelDock; order?: number }> = [];
  const seen = new Set<string>();
  for (const entry of registry.channels) {
    const plugin = entry.plugin;
    const id = String(plugin.id).trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    if (CHAT_CHANNEL_ORDER.includes(plugin.id as ChatChannelId)) {
      continue;
    }
    const dock = entry.dock ?? buildDockFromPlugin(plugin);
    entries.push({ id: plugin.id, dock, order: plugin.meta.order });
  }
  return entries;
}

export function listChannelDocks(): ChannelDock[] {
  const baseEntries = CHAT_CHANNEL_ORDER.map((id) => ({
    id,
    dock: DOCKS[id],
    order: getChatChannelMeta(id).order,
  }));
  const pluginEntries = listPluginDockEntries();
  const combined = [...baseEntries, ...pluginEntries];
  combined.sort((a, b) => {
    const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id as ChatChannelId);
    const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id as ChatChannelId);
    const orderA = a.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return String(a.id).localeCompare(String(b.id));
  });
  return combined.map((entry) => entry.dock);
}

export function getChannelDock(id: ChannelId): ChannelDock | undefined {
  const core = DOCKS[id as ChatChannelId];
  if (core) {
    return core;
  }
  const registry = requireActivePluginRegistry();
  const pluginEntry = registry.channels.find((entry) => entry.plugin.id === id);
  if (!pluginEntry) {
    return undefined;
  }
  return pluginEntry.dock ?? buildDockFromPlugin(pluginEntry.plugin);
}
