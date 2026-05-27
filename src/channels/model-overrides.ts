import type { OpenClawConfig } from "../config/config.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  type ChannelMatchSource,
} from "./channel-config.js";

const THREAD_SUFFIX_REGEX = /:(?:thread|topic):[^:]+$/i;

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

function resolveParentGroupId(groupId: string | undefined): string | undefined {
  const raw = groupId?.trim();
  if (!raw || !THREAD_SUFFIX_REGEX.test(raw)) {
    return undefined;
  }
  const parent = raw.replace(THREAD_SUFFIX_REGEX, "").trim();
  return parent && parent !== raw ? parent : undefined;
}

function resolveGroupIdFromSessionKey(sessionKey?: string | null): string | undefined {
  const raw = sessionKey?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(raw);
  const candidate = parsed?.rest ?? raw;
  const match = candidate.match(/(?:^|:)(?:group|channel):([^:]+)(?::|$)/i);
  const id = match?.[1]?.trim();
  return id || undefined;
}

function buildChannelCandidates(
  params: Pick<
    ChannelModelOverrideParams,
    "groupId" | "groupChannel" | "groupSubject" | "parentSessionKey"
  >,
) {
  const groupId = params.groupId?.trim();
  const parentGroupId = resolveParentGroupId(groupId);
  const parentGroupIdFromSession = resolveGroupIdFromSessionKey(params.parentSessionKey);
  const parentGroupIdResolved =
    resolveParentGroupId(parentGroupIdFromSession) ?? parentGroupIdFromSession;
  const groupChannel = params.groupChannel?.trim();
  const groupSubject = params.groupSubject?.trim();
  const channelBare = groupChannel ? groupChannel.replace(/^#/, "") : undefined;
  const subjectBare = groupSubject ? groupSubject.replace(/^#/, "") : undefined;
  const channelSlug = channelBare ? normalizeChannelSlug(channelBare) : undefined;
  const subjectSlug = subjectBare ? normalizeChannelSlug(subjectBare) : undefined;

  return buildChannelKeyCandidates(
    groupId,
    parentGroupId,
    parentGroupIdResolved,
    groupChannel,
    channelBare,
    channelSlug,
    groupSubject,
    subjectBare,
    subjectSlug,
  );
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
