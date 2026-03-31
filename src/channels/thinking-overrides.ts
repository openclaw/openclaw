import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  parseSessionConversationRef,
  parseThreadSessionSuffix,
} from "../sessions/session-key-utils.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  type ChannelMatchSource,
} from "./channel-config.js";

export type ChannelThinkingOverride = {
  channel: string;
  thinking: ThinkLevel;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};

type ChannelThinkingByChannelConfig = Record<string, Record<string, string>>;

type ChannelThinkingOverrideParams = {
  cfg: OpenClawConfig;
  channel?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSubject?: string | null;
  parentSessionKey?: string | null;
};

function resolveProviderEntry(
  thinkingByChannel: ChannelThinkingByChannelConfig | undefined,
  channel: string,
): Record<string, string> | undefined {
  const normalized = normalizeMessageChannel(channel) ?? channel.trim().toLowerCase();
  return (
    thinkingByChannel?.[normalized] ??
    thinkingByChannel?.[
      Object.keys(thinkingByChannel ?? {}).find((key) => {
        const normalizedKey = normalizeMessageChannel(key) ?? key.trim().toLowerCase();
        return normalizedKey === normalized;
      }) ?? ""
    ]
  );
}

function resolveParentGroupId(
  groupId: string | undefined,
  channelHint?: string | null,
): string | undefined {
  const raw = groupId?.trim();
  if (!raw) {
    return undefined;
  }
  const parent = parseThreadSessionSuffix(raw, { channelHint }).baseSessionKey?.trim();
  return parent && parent !== raw ? parent : undefined;
}

function resolveSenderScopedParentGroupId(groupId: string | undefined): string | undefined {
  const raw = groupId?.trim();
  if (!raw) {
    return undefined;
  }
  const parent = raw.replace(/:sender:[^:]+$/i, "").trim();
  return parent && parent !== raw ? parent : undefined;
}

function resolveGroupIdFromSessionKey(sessionKey?: string | null): string | undefined {
  return parseSessionConversationRef(sessionKey)?.id;
}

function buildChannelCandidates(
  params: Pick<
    ChannelThinkingOverrideParams,
    "channel" | "groupId" | "groupChannel" | "groupSubject" | "parentSessionKey"
  >,
) {
  const normalizedChannel =
    normalizeMessageChannel(params.channel ?? "") ?? params.channel?.trim().toLowerCase();
  const groupId = params.groupId?.trim();
  const senderParentGroupId = resolveSenderScopedParentGroupId(groupId);
  const parentGroupId = resolveParentGroupId(groupId, normalizedChannel);
  const parentGroupIdFromSession = resolveGroupIdFromSessionKey(params.parentSessionKey);
  const senderParentGroupIdFromSession = resolveSenderScopedParentGroupId(parentGroupIdFromSession);
  const parentGroupIdResolved =
    resolveParentGroupId(parentGroupIdFromSession, normalizedChannel) ?? parentGroupIdFromSession;
  const senderParentResolved =
    resolveParentGroupId(senderParentGroupId, normalizedChannel) ?? senderParentGroupId;
  const senderParentFromSessionResolved =
    resolveParentGroupId(senderParentGroupIdFromSession, normalizedChannel) ??
    senderParentGroupIdFromSession;
  const groupChannel = params.groupChannel?.trim();
  const groupSubject = params.groupSubject?.trim();
  const channelBare = groupChannel ? groupChannel.replace(/^#/, "") : undefined;
  const subjectBare = groupSubject ? groupSubject.replace(/^#/, "") : undefined;
  const channelSlug = channelBare ? normalizeChannelSlug(channelBare) : undefined;
  const subjectSlug = subjectBare ? normalizeChannelSlug(subjectBare) : undefined;

  return buildChannelKeyCandidates(
    groupId,
    senderParentGroupId,
    senderParentResolved,
    parentGroupId,
    parentGroupIdFromSession,
    senderParentGroupIdFromSession,
    senderParentFromSessionResolved,
    parentGroupIdResolved,
    groupChannel,
    channelBare,
    channelSlug,
    groupSubject,
    subjectBare,
    subjectSlug,
  );
}

export function resolveChannelThinkingOverride(
  params: ChannelThinkingOverrideParams,
): ChannelThinkingOverride | null {
  const channel = params.channel?.trim();
  if (!channel) {
    return null;
  }
  const thinkingByChannel = (params.cfg.channels as Record<string, unknown> | undefined)
    ?.thinkingByChannel as ChannelThinkingByChannelConfig | undefined;
  if (!thinkingByChannel) {
    return null;
  }
  const providerEntries = resolveProviderEntry(thinkingByChannel, channel);
  if (!providerEntries) {
    return null;
  }

  const candidates = buildChannelCandidates(params);
  if (candidates.length === 0) {
    return null;
  }
  const match = resolveChannelEntryMatchWithFallback({
    entries: providerEntries,
    keys: candidates,
    wildcardKey: "*",
    normalizeKey: (value) => value.trim().toLowerCase(),
  });
  const raw = match.entry ?? match.wildcardEntry;
  if (typeof raw !== "string") {
    return null;
  }
  const thinking = normalizeThinkLevel(raw.trim());
  if (!thinking) {
    return null;
  }

  return {
    channel: normalizeMessageChannel(channel) ?? channel.trim().toLowerCase(),
    thinking,
    matchKey: match.matchKey,
    matchSource: match.matchSource,
  };
}
