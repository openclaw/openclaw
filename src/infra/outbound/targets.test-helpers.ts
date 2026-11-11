import { parseTelegramTargetForTest } from "../../../test/helpers/infra/telegram-targets.js";
import type {
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildChannelOutboundSessionRoute } from "../../plugin-sdk/core.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

function stripTestPrefix(raw: string, channelId: string): string {
  return raw.replace(new RegExp(`^${channelId}:`, "i"), "").trim();
}

function parseForumTargetForTest(raw: string) {
  const trimmed = stripTestPrefix(raw.trim(), "forum");
  const topicMatch = /^(.*):topic:(\d+)$/i.exec(trimmed);
  const roomId = topicMatch?.[1]?.trim() || trimmed;
  const threadId = topicMatch?.[2] ? Number.parseInt(topicMatch[2], 10) : undefined;
  const chatType = roomId.startsWith("dm:")
    ? "direct"
    : roomId.startsWith("room:")
      ? "group"
      : "unknown";
  return { roomId, threadId, chatType } as const;
}

export const telegramMessagingForTest: ChannelMessagingAdapter = {
  targetPrefixes: ["telegram", "tg"],
  inferTargetChatType: ({ to }) => {
    const target = parseTelegramTargetForTest(to);
    return target.chatType === "unknown" ? undefined : target.chatType;
  },
  resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target, resolvedTarget, threadId }) => {
    const parsed = parseTelegramTargetForTest(target);
    const resolvedThreadId = parsed.messageThreadId ?? threadId ?? undefined;
    const isGroup =
      parsed.chatType === "group" ||
      (parsed.chatType === "unknown" &&
        resolvedTarget?.kind !== undefined &&
        resolvedTarget.kind !== "user");
    const peerId =
      isGroup && resolvedThreadId ? `${parsed.chatId}:topic:${resolvedThreadId}` : parsed.chatId;
    return buildChannelOutboundSessionRoute({
      cfg,
      agentId,
      channel: "telegram",
      accountId,
      peer: { kind: isGroup ? "group" : "direct", id: peerId },
      chatType: isGroup ? "group" : "direct",
      from: isGroup ? `telegram:group:${peerId}` : `telegram:${parsed.chatId}`,
      to: parsed.chatId,
      ...(resolvedThreadId !== undefined ? { threadId: resolvedThreadId } : {}),
    });
  },
};

export const forumMessagingForTest: ChannelMessagingAdapter = {
  targetPrefixes: ["forum"],
  inferTargetChatType: ({ to }) => {
    const target = parseForumTargetForTest(to);
    return target.chatType === "unknown" ? undefined : target.chatType;
  },
  targetResolver: { hint: "<room|dm target>" },
  resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target, threadId }) => {
    const parsed = parseForumTargetForTest(target);
    const resolvedThreadId = parsed.threadId ?? threadId ?? undefined;
    const chatType = parsed.chatType === "direct" ? "direct" : "group";
    return buildChannelOutboundSessionRoute({
      cfg,
      agentId,
      channel: "forum",
      accountId,
      peer: { kind: chatType, id: parsed.roomId },
      chatType,
      from: chatType === "direct" ? `forum:${parsed.roomId}` : `forum:group:${parsed.roomId}`,
      to: parsed.roomId,
      ...(resolvedThreadId !== undefined ? { threadId: resolvedThreadId } : {}),
    });
  },
  preserveHeartbeatThreadIdForGroupRoute: true,
};

export function createTestChannelPlugin(params: {
  id: ChannelPlugin["id"];
  label?: string;
  outbound?: ChannelOutboundAdapter;
  messaging?: ChannelMessagingAdapter;
  resolveDefaultTo?: (params: { cfg: OpenClawConfig }) => string | undefined;
}): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: params.id,
      label: params.label,
      capabilities: { chatTypes: ["direct", "group"] },
      config: {
        listAccountIds: () => [],
        ...(params.resolveDefaultTo ? { resolveDefaultTo: params.resolveDefaultTo } : {}),
      },
    }),
    ...(params.outbound ? { outbound: params.outbound } : {}),
    ...(params.messaging ? { messaging: params.messaging } : {}),
  };
}

export function createGenericTargetTestPlugin(
  id: ChannelPlugin["id"],
  label = String(id),
): ChannelPlugin {
  return createTestChannelPlugin({
    id,
    label,
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: id, messageId: `${id}-msg` }),
      resolveTarget: ({ to }) => {
        const normalized =
          to && stripTestPrefix(to, String(id)).toLowerCase().replace(/\s+/gu, "-");
        return !normalized || normalized === "invalid"
          ? { ok: false, error: new Error(`${label} target is required`) }
          : { ok: true, to: normalized };
      },
    },
    messaging: {
      targetPrefixes: [String(id)],
      // Syntax alone never admits an implicit owner destination.
      inferTargetChatType: ({ to }) => (/^user:/i.test(to) ? "direct" : undefined),
    },
    resolveDefaultTo: ({ cfg }) => {
      const channels = cfg.channels as Record<string, { defaultTo?: unknown }> | undefined;
      const value = channels?.[id]?.defaultTo;
      return typeof value === "string" ? value : undefined;
    },
  });
}

export function createForumTargetTestPlugin(): ChannelPlugin {
  return { ...createGenericTargetTestPlugin("forum", "Forum"), messaging: forumMessagingForTest };
}

export function createTargetsTestRegistry(
  plugins: ChannelPlugin[] = [
    createGenericTargetTestPlugin("alpha", "Alpha"),
    createGenericTargetTestPlugin("beta", "Beta"),
    createForumTargetTestPlugin(),
  ],
) {
  return createTestRegistry(
    plugins.map((plugin) => ({ pluginId: plugin.id, plugin, source: "test" })),
  );
}
