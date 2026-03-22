import { resolveChannelGroupRequireMention, resolveChannelGroupToolsPolicy } from "../config/group-policy.js";
import {
  mapAllowFromEntries,
  resolveOptionalConfigString,
} from "../plugin-sdk/channel-config-helpers.js";
import { inspectTelegramAccount } from "../telegram/account-inspect.js";
import {
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
} from "./plugins/group-mentions.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId, getChatChannelMeta } from "./registry.js";
import type {
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelGroupAdapter,
  ChannelId,
  ChannelMentionAdapter,
  ChannelThreadingAdapter,
  ChannelThreadingContext,
  ChannelThreadingToolContext,
} from "./plugins/types.js";

export type ChannelDock = {
  id: ChannelId;
  capabilities: ChannelCapabilities;
  config?: Pick<
    ChannelConfigAdapter<unknown>,
    "resolveAllowFrom" | "formatAllowFrom" | "resolveDefaultTo"
  >;
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  threading?: ChannelThreadingAdapter;
  // Simplified implementation stubs (removed channels support)
  commands?: {
    enforceOwnerForCommands?: boolean;
  };
  outbound?: {
    textChunkLimit?: number;
  };
  streaming?: {
    blockStreamingCoalesceDefaults?: {
      minChars?: number;
      idleMs?: number;
    };
  };
  elevated?: {
    allowFromFallback?: (params: { cfg: unknown; accountId?: string | null }) => string[];
  };
  agentPrompt?: {
    enabled?: boolean;
  };
};

type ChannelDockStreaming = {
  blockStreamingCoalesceDefaults?: {
    minChars?: number;
    idleMs?: number;
  };
};

function resolveDirectOrGroupChannelId(context: ChannelThreadingContext): string | undefined {
  const isDirect = context.ChatType?.toLowerCase() === "direct";
  return (isDirect ? (context.From ?? context.To) : context.To)?.trim() || undefined;
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
    config: {
      resolveAllowFrom: ({ cfg, accountId }) =>
        mapAllowFromEntries(inspectTelegramAccount({ cfg, accountId }).config.allowFrom),
      formatAllowFrom: ({ allowFrom }) =>
        mapAllowFromEntries(allowFrom).map((entry) =>
          entry.replace(/^(telegram|tg):/i, "").trim(),
        ),
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveOptionalConfigString(inspectTelegramAccount({ cfg, accountId }).config.defaultTo),
    },
    groups: {
      resolveRequireMention: resolveTelegramGroupRequireMention,
      resolveToolPolicy: resolveTelegramGroupToolPolicy,
    },
    threading: {
      resolveReplyToMode: ({ cfg }) => cfg.channels?.telegram?.replyToMode ?? "off",
      buildToolContext: ({ context, hasRepliedRef }) => {
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
    // Simplified implementation stubs
    commands: {
      enforceOwnerForCommands: false,
    },
    outbound: {},
    streaming: {
      blockStreamingCoalesceDefaults: {
        minChars: 100,
        idleMs: 500,
      },
    },
    elevated: {
      allowFromFallback: undefined,
    },
    agentPrompt: {
      enabled: true,
    },
  },
  feishu: {
    id: "feishu",
    capabilities: {
      chatTypes: ["direct", "group"],
      nativeCommands: true,
      blockStreaming: true,
    },
    config: {
      resolveAllowFrom: ({ cfg, accountId }) => {
        const account = cfg.channels?.feishu?.accounts?.[accountId ?? "default"] ?? cfg.channels?.feishu;
        return mapAllowFromEntries(account?.allowFrom);
      },
      formatAllowFrom: ({ allowFrom }) =>
        mapAllowFromEntries(allowFrom).map((entry) => entry.toLowerCase()),
      resolveDefaultTo: ({ cfg, accountId }) => {
        const account = cfg.channels?.feishu?.accounts?.[accountId ?? "default"] ?? cfg.channels?.feishu;
        return account?.defaultTo?.trim() || undefined;
      },
    },
    groups: {
      resolveRequireMention: ({ cfg, accountId, groupId }) => {
        if (!groupId) {
          return true;
        }
        return resolveChannelGroupRequireMention({
          cfg,
          channel: "feishu",
          groupId,
          accountId,
        });
      },
      resolveToolPolicy: ({ cfg, accountId, groupId }) => {
        if (!groupId) {
          return undefined;
        }
        return resolveChannelGroupToolsPolicy({
          cfg,
          channel: "feishu",
          groupId,
          accountId,
        });
      },
    },
    // Simplified implementation stubs
    commands: {
      enforceOwnerForCommands: false,
    },
    outbound: {},
    streaming: {
      blockStreamingCoalesceDefaults: {
        minChars: 100,
        idleMs: 500,
      },
    },
    elevated: {
      allowFromFallback: undefined,
    },
    agentPrompt: {
      enabled: true,
    },
  },
};

export function listChannelDocks(): ChannelDock[] {
  const baseEntries = CHAT_CHANNEL_ORDER.map((id) => ({
    id,
    dock: DOCKS[id],
    order: getChatChannelMeta(id).order,
  }));
  const combined = [...baseEntries];
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
  return undefined;
}
