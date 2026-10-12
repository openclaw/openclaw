import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelRouteRef } from "../../plugin-sdk/channel-route.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "../../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../../utils/message-channel-core.js";
import { resolveGroupSessionKey } from "./group.js";
import {
  mergeSessionOrigin,
  projectLastRoutePatch,
  projectSessionMetaPatch,
  type PreparedSessionMetaPatch,
} from "./metadata-projection.js";
import type { GroupKeyResolution, SessionEntry, SessionOrigin } from "./types.js";

export function deriveSessionOrigin(
  ctx: MsgContext,
  opts?: { skipSystemEventOrigin?: boolean },
): SessionOrigin | undefined {
  if (opts?.skipSystemEventOrigin && ctx.InternalTurnSource !== undefined) {
    return undefined;
  }
  const providerRaw =
    (typeof ctx.OriginatingChannel === "string" && ctx.OriginatingChannel) ||
    ctx.Surface ||
    ctx.Provider;
  return mergeSessionOrigin(undefined, {
    label: normalizeOptionalString(resolveConversationLabel(ctx)),
    provider: normalizeMessageChannel(providerRaw),
    surface: normalizeOptionalLowercaseString(ctx.Surface),
    chatType: normalizeChatType(ctx.ChatType) ?? undefined,
    from: normalizeOptionalString(ctx.From),
    to: normalizeOptionalString(typeof ctx.OriginatingTo === "string" ? ctx.OriginatingTo : ctx.To),
    nativeChannelId: normalizeOptionalString(ctx.NativeChannelId),
    nativeDirectUserId: normalizeOptionalString(ctx.NativeDirectUserId),
    avatar: normalizeOptionalString(ctx.ConversationAvatar),
    accountId: normalizeOptionalString(ctx.AccountId),
    threadId: ctx.MessageThreadId ?? undefined,
  });
}

function prepareGroupSessionPatch(params: {
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
}) {
  const resolution = params.groupResolution ?? resolveGroupSessionKey(params.ctx);
  if (!resolution?.channel) {
    return null;
  }

  const channel = resolution.channel;
  const subject = normalizeOptionalString(params.ctx.GroupSubject);
  const topicName = normalizeOptionalString(params.ctx.TopicName);
  const space = params.ctx.GroupSpace?.trim();
  const explicitChannel = params.ctx.GroupChannel?.trim();
  const subjectLooksChannel = Boolean(subject?.startsWith("#"));
  // Channel-looking subjects become `groupChannel` only for channel-capable providers; ordinary
  // group chats keep the subject as human-readable metadata.
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

  return { resolution, nextSubject, nextGroupChannel, topicName, space };
}

export function deriveSessionMetaPatch(params: {
  ctx: MsgContext;
  sessionKey: string;
  existing?: SessionEntry;
  groupResolution?: GroupKeyResolution | null;
  preserveExistingDeliveryRoute?: boolean;
  skipSystemEventOrigin?: boolean;
}): Partial<SessionEntry> | null {
  return projectSessionMetaPatch({
    ...params,
    prepared: prepareSessionMetaPatch(params),
  });
}

/** Resolve plugin-owned ingress facts once, before handing pure metadata to the writer. */
export function prepareSessionMetaPatch(params: {
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  skipSystemEventOrigin?: boolean;
}): PreparedSessionMetaPatch {
  const sourceChannel = normalizeMessageChannel(
    params.ctx.Provider ?? params.ctx.Surface ?? params.ctx.OriginatingChannel,
  );
  return {
    group: prepareGroupSessionPatch(params),
    origin: deriveSessionOrigin(params.ctx, {
      skipSystemEventOrigin: params.skipSystemEventOrigin,
    }),
    internalTurn:
      params.ctx.InternalTurnSource !== undefined ||
      sourceChannel === INTERNAL_MESSAGE_CHANNEL ||
      (sourceChannel != null && isInternalNonDeliveryChannel(sourceChannel)),
  };
}

/**
 * Derives the last-route/delivery patch for an inbound routing update. Route
 * updates must not refresh activity timestamps; idle/daily reset evaluation
 * relies on updatedAt from actual session turns (#49515). Shared by the file
 * store and the SQLite accessor so both backends apply one routing policy.
 */
export function deriveLastRoutePatch(params: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  route?: ChannelRouteRef;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  existing: SessionEntry | undefined;
  sessionKey: string;
}): Partial<SessionEntry> {
  return projectLastRoutePatch({
    ...params,
    metadata: params.ctx
      ? prepareSessionMetaPatch({ ctx: params.ctx, groupResolution: params.groupResolution })
      : undefined,
  });
}
