import type { OpenClawConfig } from "../config/config.js";
import { parseFeishuConversationId } from "../plugin-sdk/feishu-conversation.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  type ChannelMatchSource,
} from "./channel-config.js";
import { normalizeChatType } from "./chat-type.js";
import { getChannelPlugin } from "./plugins/registry.js";
import {
  resolveSessionConversation,
  resolveSessionConversationRef,
} from "./plugins/session-conversation.js";

export type ChannelModelOverride = {
  channel: string;
  model: string;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};

type ChannelModelByChannelConfig = Record<string, Record<string, string>>;

type ChannelModelOverrideParams = {
  cfg: OpenClawConfig;
  channel?: string | null;
  groupId?: string | null;
  groupChatType?: string | null;
  groupChannel?: string | null;
  groupSubject?: string | null;
  parentSessionKey?: string | null;
};

function resolveProviderEntry(
  modelByChannel: ChannelModelByChannelConfig | undefined,
  channel: string,
): Record<string, string> | undefined {
  const normalized = normalizeMessageChannel(channel) ?? channel.trim().toLowerCase();
  return (
    modelByChannel?.[normalized] ??
    modelByChannel?.[
      Object.keys(modelByChannel ?? {}).find((key) => {
        const normalizedKey = normalizeMessageChannel(key) ?? key.trim().toLowerCase();
        return normalizedKey === normalized;
      }) ?? ""
    ]
  );
}

function buildChannelCandidates(
  params: Pick<
    ChannelModelOverrideParams,
    "channel" | "groupId" | "groupChatType" | "groupChannel" | "groupSubject" | "parentSessionKey"
  >,
): { keys: string[]; parentKeys: string[] } {
  const normalizedChannel =
    normalizeMessageChannel(params.channel ?? "") ?? params.channel?.trim().toLowerCase();
  const groupId = params.groupId?.trim();
  const sessionConversation = resolveSessionConversationRef(params.parentSessionKey);
  const bundledParentOverrideFallbacks = resolveBundledParentOverrideFallbacks({
    channel: normalizedChannel,
    parentConversationId: sessionConversation?.rawId,
  });
  const parentOverrideFallbacks =
    (normalizedChannel
      ? getChannelPlugin(
          normalizedChannel,
        )?.conversationBindings?.buildModelOverrideParentCandidates?.({
          parentConversationId: sessionConversation?.rawId,
        })
      : null) ?? bundledParentOverrideFallbacks;
  const groupConversationKind =
    normalizeChatType(params.groupChatType ?? undefined) === "channel"
      ? "channel"
      : sessionConversation?.kind === "channel"
        ? "channel"
        : "group";
  const groupConversation = resolveSessionConversation({
    channel: normalizedChannel ?? "",
    kind: groupConversationKind,
    rawId: groupId ?? "",
  });
  const groupChannel = params.groupChannel?.trim();
  const groupSubject = params.groupSubject?.trim();
  const channelBare = groupChannel ? groupChannel.replace(/^#/, "") : undefined;
  const subjectBare = groupSubject ? groupSubject.replace(/^#/, "") : undefined;
  const channelSlug = channelBare ? normalizeChannelSlug(channelBare) : undefined;
  const subjectSlug = subjectBare ? normalizeChannelSlug(subjectBare) : undefined;

  return {
    keys: buildChannelKeyCandidates(
      groupId,
      sessionConversation?.rawId,
      ...(groupConversation?.parentConversationCandidates ?? []),
      ...(sessionConversation?.parentConversationCandidates ?? []),
      ...parentOverrideFallbacks,
    ),
    parentKeys: buildChannelKeyCandidates(
      groupChannel,
      channelBare,
      channelSlug,
      groupSubject,
      subjectBare,
      subjectSlug,
    ),
  };
}

function resolveBundledParentOverrideFallbacks(params: {
  channel?: string | null;
  parentConversationId?: string | null;
}): string[] {
  if (params.channel !== "feishu") {
    return [];
  }
  const parsed = parseFeishuConversationId({
    conversationId: params.parentConversationId ?? "",
  });
  if (!parsed) {
    return [];
  }
  switch (parsed.scope) {
    case "group_topic_sender":
      return buildChannelKeyCandidates(
        parsed.topicId ? `${parsed.chatId}:topic:${parsed.topicId}` : undefined,
        parsed.chatId,
      );
    case "group_topic":
    case "group_sender":
      return buildChannelKeyCandidates(parsed.chatId);
    case "group":
    default:
      return [];
  }
}

export function resolveChannelModelOverride(
  params: ChannelModelOverrideParams,
): ChannelModelOverride | null {
  const channel = params.channel?.trim();
  if (!channel) {
    return null;
  }
  const modelByChannel = params.cfg.channels?.modelByChannel as
    | ChannelModelByChannelConfig
    | undefined;
  if (!modelByChannel) {
    return null;
  }
  const providerEntries = resolveProviderEntry(modelByChannel, channel);
  if (!providerEntries) {
    return null;
  }

  const { keys, parentKeys } = buildChannelCandidates(params);
  if (keys.length === 0 && parentKeys.length === 0) {
    return null;
  }
  const match = resolveChannelEntryMatchWithFallback({
    entries: providerEntries,
    keys,
    parentKeys,
    wildcardKey: "*",
    normalizeKey: (value) => value.trim().toLowerCase(),
  });
  const raw = match.entry ?? match.wildcardEntry;
  if (typeof raw !== "string") {
    return null;
  }
  const model = raw.trim();
  if (!model) {
    return null;
  }

  return {
    channel: normalizeMessageChannel(channel) ?? channel.trim().toLowerCase(),
    model,
    matchKey: match.matchKey,
    matchSource: match.matchSource,
  };
}
