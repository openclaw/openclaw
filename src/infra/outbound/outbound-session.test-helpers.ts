import { expectDefined } from "@openclaw/normalization-core";
// Test helpers build minimal plugin registries for outbound session-route
// scenarios without importing real channel implementations.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  type ChannelOutboundSessionRouteParams,
} from "../../plugin-sdk/core.js";
import { normalizeOutboundThreadId, type RoutePeer } from "../../plugin-sdk/routing.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

function createSessionRouteTestPlugin(params: {
  id: ChannelPlugin["id"];
  label: string;
  resolveOutboundSessionRoute: (
    params: ChannelOutboundSessionRouteParams,
  ) => Awaited<
    ReturnType<NonNullable<NonNullable<ChannelPlugin["messaging"]>["resolveOutboundSessionRoute"]>>
  >;
}): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: params.id,
      label: params.label,
      capabilities: { chatTypes: ["direct", "group", "channel"] },
    }),
    messaging: {
      resolveOutboundSessionRoute: params.resolveOutboundSessionRoute,
    },
  };
}

function buildRoute(
  { cfg, agentId, accountId }: ChannelOutboundSessionRouteParams,
  channel: string,
  kind: RoutePeer["kind"],
  id: string,
  options: {
    from?: string;
    to?: string;
    threadId?: string | number;
    threaded?: boolean;
    useSuffix?: boolean;
  } = {},
) {
  const route = buildChannelOutboundSessionRoute({
    cfg,
    agentId,
    accountId,
    channel,
    peer: { kind, id },
    chatType: kind,
    from: options.from ?? `${channel}:${kind === "direct" ? "" : `${kind}:`}${id}`,
    to: options.to ?? `${channel}:${id}`,
    ...(!options.threaded && options.threadId !== undefined ? { threadId: options.threadId } : {}),
  });
  return options.threaded
    ? buildThreadAwareOutboundSessionRoute({
        route,
        threadId: options.threadId,
        useSuffix: options.useSuffix,
        precedence: ["threadId", "replyToId", "currentSession"],
      })
    : route;
}

function parseForumTargetForTest(raw: string): {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
} {
  const trimmed = raw
    .trim()
    .replace(/^forum:/i, "")
    .replace(/^group:/i, "");
  const prefixedTopic = /^([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (prefixedTopic) {
    const chatId = expectDefined(prefixedTopic[1], "prefixed topic capture group 1");
    return {
      chatId,
      messageThreadId: Number.parseInt(
        expectDefined(prefixedTopic[2], "prefixed topic capture group 2"),
        10,
      ),
      chatType: chatId.startsWith("-") ? "group" : "direct",
    };
  }
  return {
    chatId: trimmed,
    chatType: trimmed.startsWith("-") ? "group" : trimmed.startsWith("@") ? "unknown" : "direct",
  };
}

function parseForumThreadIdForTest(threadId?: string | number | null): number | undefined {
  const normalized = normalizeOutboundThreadId(threadId);
  if (!normalized) {
    return undefined;
  }
  const topicMatch = /(?:^|:topic:|:)(\d+)$/i.exec(normalized);
  if (!topicMatch) {
    return undefined;
  }
  return Number.parseInt(expectDefined(topicMatch[1], "topic match capture group 1"), 10);
}

function buildForumGroupPeerIdForTest(chatId: string, messageThreadId?: number): string {
  return messageThreadId ? `${chatId}:topic:${messageThreadId}` : chatId;
}

function resolveForumOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const parsed = parseForumTargetForTest(params.target);
  const chatId = parsed.chatId.trim();
  if (!chatId) {
    return null;
  }
  const resolvedThreadId = parsed.messageThreadId ?? parseForumThreadIdForTest(params.threadId);
  const isGroup =
    parsed.chatType === "group" ||
    (parsed.chatType === "unknown" &&
      params.resolvedTarget?.kind !== undefined &&
      params.resolvedTarget.kind !== "user");
  const peerId =
    isGroup && resolvedThreadId ? buildForumGroupPeerIdForTest(chatId, resolvedThreadId) : chatId;
  if (isGroup) {
    return buildRoute(params, "forum", "group", peerId, {
      to: `forum:${chatId}`,
      threadId: resolvedThreadId,
    });
  }
  return buildRoute(params, "forum", "direct", peerId, {
    from:
      resolvedThreadId !== undefined
        ? `forum:${chatId}:topic:${resolvedThreadId}`
        : `forum:${chatId}`,
    threadId: resolvedThreadId,
    threaded: true,
  });
}

function resolveWorkspaceOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = params.target.trim();
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const rawId = stripTargetKindPrefix(stripChannelTargetPrefix(trimmed, "workspace"));
  if (!rawId) {
    return null;
  }
  const normalizedId = normalizeLowercaseStringOrEmpty(rawId);
  const isDm = lower.startsWith("user:") || lower.startsWith("workspace:") || /^u/i.test(rawId);
  const workspaceConfig = params.cfg.channels?.workspace as
    | { dm?: { groupChannels?: unknown[] } }
    | undefined;
  const isGroupChannel =
    /^g/i.test(rawId) &&
    Array.isArray(workspaceConfig?.dm?.groupChannels) &&
    workspaceConfig.dm.groupChannels.some(
      (candidate: unknown) => normalizeLowercaseStringOrEmpty(String(candidate)) === normalizedId,
    );
  const peerKind: RoutePeer["kind"] = isDm ? "direct" : isGroupChannel ? "group" : "channel";
  return buildRoute(params, "workspace", peerKind, normalizedId, {
    from: isDm
      ? `workspace:${rawId}`
      : isGroupChannel
        ? `workspace:group:${rawId}`
        : `workspace:channel:${rawId}`,
    to: isDm ? `user:${rawId}` : `channel:${rawId}`,
    threadId: params.replyToId ?? params.threadId ?? undefined,
    threaded: true,
  });
}

function resolveGuildChatOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = params.target.trim();
  if (!trimmed) {
    return null;
  }
  const resolvedKind = params.resolvedTarget?.kind;
  let kind: "user" | "channel";
  if (resolvedKind === "user") {
    kind = "user";
  } else if (resolvedKind === "channel" || resolvedKind === "group") {
    kind = "channel";
  } else if (/^user:/i.test(trimmed) || /^guildchat:/i.test(trimmed) || /^<@!?/.test(trimmed)) {
    kind = "user";
  } else if (/^channel:/i.test(trimmed)) {
    kind = "channel";
  } else if (/^\d+$/u.test(trimmed)) {
    throw new Error("Ambiguous Guild Chat recipient");
  } else {
    kind = "channel";
  }
  const rawId = stripTargetKindPrefix(stripChannelTargetPrefix(trimmed, "guildchat"));
  if (!rawId) {
    return null;
  }
  return buildRoute(params, "guildchat", kind === "user" ? "direct" : "channel", rawId, {
    to: kind === "user" ? `user:${rawId}` : `channel:${rawId}`,
    threadId: params.threadId ?? undefined,
    useSuffix: false,
    threaded: true,
  });
}

function resolveBoardChatOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = params.target.trim();
  if (!trimmed) {
    return null;
  }
  const isUser = params.resolvedTarget?.kind === "user" || /^user:/i.test(trimmed);
  const rawId = stripTargetKindPrefix(stripChannelTargetPrefix(trimmed, "boardchat"));
  if (!rawId) {
    return null;
  }
  return buildRoute(params, "boardchat", isUser ? "direct" : "channel", rawId, {
    to: isUser ? `user:${rawId}` : `channel:${rawId}`,
    threadId: params.replyToId ?? params.threadId ?? undefined,
    threaded: true,
  });
}

function resolveMobileChatOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const normalized = normalizeOptionalLowercaseString(
    stripChannelTargetPrefix(params.target, "mobilechat"),
  );
  if (!normalized) {
    return null;
  }
  const isGroup = normalized.endsWith("@g.us");
  return buildRoute(params, "mobilechat", isGroup ? "group" : "direct", normalized, {
    from: normalized,
    to: normalized,
  });
}

function resolveMatrixOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const stripped = stripChannelTargetPrefix(params.target, "matrix");
  const isUser =
    params.resolvedTarget?.kind === "user" || stripped.startsWith("@") || /^user:/i.test(stripped);
  const rawId = stripTargetKindPrefix(stripped);
  if (!rawId) {
    return null;
  }
  return buildRoute(params, "matrix", isUser ? "direct" : "channel", rawId, {
    to: `room:${rawId}`,
  });
}

function resolveMeetingChatOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "meetingchat", "meet");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const rawId = stripTargetKindPrefix(trimmed);
  if (!rawId) {
    return null;
  }
  const conversationId = rawId.split(";")[0] ?? rawId;
  const isUser = lower.startsWith("user:");
  const isChannel = !isUser && /@thread\.tacv2/i.test(conversationId);
  const peerKind: RoutePeer["kind"] = isUser ? "direct" : isChannel ? "channel" : "group";
  return buildRoute(params, "meetingchat", peerKind, conversationId, {
    to: isUser ? `user:${conversationId}` : `conversation:${conversationId}`,
  });
}

function resolveCollabChatOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  let trimmed = stripChannelTargetPrefix(params.target, "collabchat", "collab");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  let isGroup = false;
  if (lower.startsWith("group:") || lower.startsWith("chat:") || lower.startsWith("channel:")) {
    trimmed = trimmed.replace(/^(group|chat|channel):/i, "").trim();
    isGroup = true;
  } else if (lower.startsWith("user:") || lower.startsWith("dm:")) {
    trimmed = trimmed.replace(/^(user|dm):/i, "").trim();
  } else if (
    !normalizeLowercaseStringOrEmpty(trimmed).startsWith("ou_") &&
    !normalizeLowercaseStringOrEmpty(trimmed).startsWith("on_")
  ) {
    isGroup = false;
  }
  return buildRoute(params, "collabchat", isGroup ? "group" : "direct", trimmed, {
    to: trimmed,
  });
}

function resolveNextcloudTalkOutboundSessionRouteForTest(
  params: ChannelOutboundSessionRouteParams,
) {
  const roomId = stripTargetKindPrefix(
    stripChannelTargetPrefix(params.target, "nextcloud-talk", "nc-talk", "nc"),
  );
  if (!roomId) {
    return null;
  }
  return buildRoute(params, "nextcloud-talk", "group", roomId, {
    from: `nextcloud-talk:room:${roomId}`,
  });
}

function resolveLocalChatOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const stripped = stripChannelTargetPrefix(params.target, "localchat");
  if (!stripped) {
    return null;
  }
  const match = /^(chat_guid|chat_identifier|chat_id):(.+)$/i.exec(stripped);
  const rawId = match
    ? expectDefined(match[2], "outbound session.test helpers regex capture 2").trim()
    : stripped.trim();
  if (!rawId) {
    return null;
  }
  const normalizedId = normalizeLowercaseStringOrEmpty(rawId);
  const isGroup = match !== null;
  return buildRoute(params, "localchat", isGroup ? "group" : "direct", normalizedId, {
    from: isGroup ? `group:${rawId}` : `localchat:${rawId}`,
    to: `localchat:${stripped}`,
  });
}

function resolveZaloOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "zalo", "zl");
  if (!trimmed) {
    return null;
  }
  const isGroup = normalizeLowercaseStringOrEmpty(trimmed).startsWith("group:");
  const peerId = stripTargetKindPrefix(trimmed);
  if (!peerId) {
    return null;
  }
  return buildRoute(params, "zalo", isGroup ? "group" : "direct", peerId);
}

function resolveZalouserOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "zalouser", "zlu");
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  const isGroup = lower.startsWith("group:") || lower.startsWith("g:");
  const peerId = trimmed.replace(/^(group|user|g|u|dm):/i, "").trim();
  if (!peerId) {
    return null;
  }
  return buildRoute(params, "zalouser", isGroup ? "group" : "direct", peerId);
}

function resolveNostrOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const target = stripChannelTargetPrefix(params.target, "nostr");
  if (!target) {
    return null;
  }
  return buildRoute(params, "nostr", "direct", target);
}

function resolveTlonOutboundSessionRouteForTest(params: ChannelOutboundSessionRouteParams) {
  const trimmed = stripChannelTargetPrefix(params.target, "tlon").trim();
  if (!trimmed) {
    return null;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("group:")) {
    const nest = `chat/${trimmed.slice("group:".length).trim()}`;
    return buildRoute(params, "tlon", "group", nest);
  }
  return buildRoute(params, "tlon", "direct", trimmed);
}

/** Installs a minimal channel registry for outbound session route tests. */
export function setMinimalOutboundSessionPluginRegistryForTests(): void {
  const routes = [
    ["mobilechat", "Mobile Chat", resolveMobileChatOutboundSessionRouteForTest],
    ["matrix", "Matrix", resolveMatrixOutboundSessionRouteForTest],
    ["meetingchat", "Meeting Chat", resolveMeetingChatOutboundSessionRouteForTest],
    ["workspace", "Workspace", resolveWorkspaceOutboundSessionRouteForTest],
    ["forum", "Forum", resolveForumOutboundSessionRouteForTest],
    ["guildchat", "Guild Chat", resolveGuildChatOutboundSessionRouteForTest],
    ["nextcloud-talk", "Nextcloud Talk", resolveNextcloudTalkOutboundSessionRouteForTest],
    ["localchat", "Local Chat", resolveLocalChatOutboundSessionRouteForTest],
    ["zalo", "Zalo", resolveZaloOutboundSessionRouteForTest],
    ["zalouser", "Zalo Personal", resolveZalouserOutboundSessionRouteForTest],
    ["nostr", "Nostr", resolveNostrOutboundSessionRouteForTest],
    ["tlon", "Tlon", resolveTlonOutboundSessionRouteForTest],
    ["collabchat", "Collab Chat", resolveCollabChatOutboundSessionRouteForTest],
    ["boardchat", "Board Chat", resolveBoardChatOutboundSessionRouteForTest],
  ] satisfies Array<
    [
      string,
      string,
      Parameters<typeof createSessionRouteTestPlugin>[0]["resolveOutboundSessionRoute"],
    ]
  >;
  const plugins: ChannelPlugin[] = [
    ...routes.map(([id, label, resolveOutboundSessionRoute]) =>
      createSessionRouteTestPlugin({ id, label, resolveOutboundSessionRoute }),
    ),
    {
      ...createChannelTestPluginBase({
        id: "fallbackchat",
        label: "Fallback Chat",
        capabilities: { chatTypes: ["direct", "group", "channel"] },
      }),
      messaging: {
        inferTargetChatType: ({ to }) => (to.startsWith("spaces/") ? "group" : undefined),
        targetPrefixes: ["fallbackchat"],
      },
    },
  ];
  setActivePluginRegistry(
    createTestRegistry(
      plugins.map((plugin) => ({
        pluginId: plugin.id,
        plugin,
        source: "test",
      })),
    ),
  );
}
