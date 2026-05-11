import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { buildGroupDisplayName, resolveGroupSessionKey } from "./group.js";
import type { GroupKeyResolution, SessionChatType, SessionEntry } from "./types.js";

export type SessionRouteMetadata = {
  label?: string;
  provider?: string;
  surface?: string;
  chatType?: SessionChatType;
  from?: string;
  to?: string;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  accountId?: string;
  threadId?: string | number;
};

export function deriveSessionRouteMetadata(
  ctx: MsgContext,
  opts?: { skipSystemEventRoute?: boolean },
): SessionRouteMetadata | undefined {
  const isSystemEventProvider =
    ctx.Provider === "heartbeat" || ctx.Provider === "cron-event" || ctx.Provider === "exec-event";
  if (opts?.skipSystemEventRoute && isSystemEventProvider) {
    return undefined;
  }
  const label = normalizeOptionalString(resolveConversationLabel(ctx));
  const providerRaw =
    (typeof ctx.OriginatingChannel === "string" && ctx.OriginatingChannel) ||
    ctx.Surface ||
    ctx.Provider;
  const provider = normalizeMessageChannel(providerRaw);
  const surface = normalizeOptionalLowercaseString(ctx.Surface);
  const chatType = normalizeChatType(ctx.ChatType) ?? undefined;
  const from = normalizeOptionalString(ctx.From);
  const to = normalizeOptionalString(
    typeof ctx.OriginatingTo === "string" ? ctx.OriginatingTo : ctx.To,
  );
  const nativeChannelId = normalizeOptionalString(ctx.NativeChannelId);
  const nativeDirectUserId = normalizeOptionalString(ctx.NativeDirectUserId);
  const accountId = normalizeOptionalString(ctx.AccountId);
  const threadId = ctx.MessageThreadId ?? undefined;

  const route: SessionRouteMetadata = {};
  if (label) {
    route.label = label;
  }
  if (provider) {
    route.provider = provider;
  }
  if (surface) {
    route.surface = surface;
  }
  if (chatType) {
    route.chatType = chatType;
  }
  if (from) {
    route.from = from;
  }
  if (to) {
    route.to = to;
  }
  if (nativeChannelId) {
    route.nativeChannelId = nativeChannelId;
  }
  if (nativeDirectUserId) {
    route.nativeDirectUserId = nativeDirectUserId;
  }
  if (accountId) {
    route.accountId = accountId;
  }
  if (threadId != null && threadId !== "") {
    route.threadId = threadId;
  }

  return Object.keys(route).length > 0 ? route : undefined;
}

export function deriveGroupSessionPatch(params: {
  ctx: MsgContext;
  sessionKey: string;
  existing?: SessionEntry;
  groupResolution?: GroupKeyResolution | null;
}): Partial<SessionEntry> | null {
  const resolution = params.groupResolution ?? resolveGroupSessionKey(params.ctx);
  if (!resolution?.channel) {
    return null;
  }

  const channel = resolution.channel;
  const subject = params.ctx.GroupSubject?.trim();
  const space = params.ctx.GroupSpace?.trim();
  const explicitChannel = params.ctx.GroupChannel?.trim();
  const subjectLooksChannel = Boolean(subject?.startsWith("#"));
  const normalizedChannel =
    subjectLooksChannel && resolution.chatType !== "channel" ? normalizeChannelId(channel) : null;
  const isChannelProvider = Boolean(
    normalizedChannel &&
    getLoadedChannelPlugin(normalizedChannel)?.capabilities.chatTypes.includes("channel"),
  );
  const nextGroupChannel =
    explicitChannel ??
    (subjectLooksChannel && subject && (resolution.chatType === "channel" || isChannelProvider)
      ? subject
      : undefined);
  const nextSubject = nextGroupChannel ? undefined : subject;

  const patch: Partial<SessionEntry> = {
    chatType: resolution.chatType ?? "group",
    channel,
    groupId: resolution.id,
  };
  if (nextSubject) {
    patch.subject = nextSubject;
  }
  if (nextGroupChannel) {
    patch.groupChannel = nextGroupChannel;
  }
  if (space) {
    patch.space = space;
  }

  const displayName = buildGroupDisplayName({
    provider: channel,
    subject: nextSubject ?? params.existing?.subject,
    groupChannel: nextGroupChannel ?? params.existing?.groupChannel,
    space: space ?? params.existing?.space,
    id: resolution.id,
    key: params.sessionKey,
  });
  if (displayName) {
    patch.displayName = displayName;
  }

  return patch;
}

export function deriveSessionMetaPatch(params: {
  ctx: MsgContext;
  sessionKey: string;
  existing?: SessionEntry;
  groupResolution?: GroupKeyResolution | null;
  skipSystemEventRoute?: boolean;
}): Partial<SessionEntry> | null {
  const groupPatch = deriveGroupSessionPatch(params);
  const isSystemEventProvider =
    params.ctx.Provider === "heartbeat" ||
    params.ctx.Provider === "cron-event" ||
    params.ctx.Provider === "exec-event";
  if (params.skipSystemEventRoute && isSystemEventProvider) {
    return groupPatch && Object.keys(groupPatch).length > 0 ? { ...groupPatch } : null;
  }

  const patch: Partial<SessionEntry> = groupPatch ? { ...groupPatch } : {};
  const chatType = normalizeChatType(params.ctx.ChatType) ?? undefined;
  if (chatType && !patch.chatType) {
    patch.chatType = chatType;
  }
  const providerRaw =
    (typeof params.ctx.OriginatingChannel === "string" && params.ctx.OriginatingChannel) ||
    params.ctx.Surface ||
    params.ctx.Provider;
  const channel = normalizeMessageChannel(providerRaw);
  if (channel && !patch.channel) {
    patch.channel = channel;
  }
  const displayName = normalizeOptionalString(resolveConversationLabel(params.ctx));
  if (displayName && !patch.displayName && !params.existing?.displayName) {
    patch.displayName = displayName;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
