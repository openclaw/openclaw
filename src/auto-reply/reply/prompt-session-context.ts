import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { GroupKeyResolution, SessionEntry } from "../../config/sessions/types.js";
import { channelRouteTargetsMatchExact } from "../../plugin-sdk/channel-route.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { TemplateContext } from "../templating.js";
import {
  normalizeEffectiveReplyTarget,
  resolveEffectiveReplyRoute,
} from "./effective-reply-route.js";
import { extractExplicitGroupId } from "./group-id.js";

type ReplyConversationFields = Pick<
  TemplateContext,
  | "Provider"
  | "Surface"
  | "ChatType"
  | "OriginatingChannel"
  | "OriginatingTo"
  | "AccountId"
  | "MessageThreadId"
  | "GroupSubject"
  | "GroupChannel"
  | "GroupSpace"
>;

export type PreparedReplyConversation = {
  fields: ReplyConversationFields;
  group: {
    channel?: string;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    accountId?: string;
  };
  activation?: SessionEntry["groupActivation"];
};

function normalizePromptRouteChannel(raw?: string | null): string | undefined {
  const normalized = normalizeOptionalString(raw);
  return normalized && normalized !== "none" ? normalized : undefined;
}

/** Whether an explicit route names the stored conversation, before inheritance fills coordinates. */
function isStoredConversationRoute(params: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  entry?: SessionEntry;
}): boolean {
  const channel = normalizeMessageChannel(params.channel);
  const to = normalizeEffectiveReplyTarget(params.to, channel, params.threadId);
  const persisted = deliveryContextFromSession(params.entry);
  const persistedChannel = normalizeMessageChannel(persisted?.channel);
  return Boolean(
    channel &&
    to &&
    channelRouteTargetsMatchExact({
      left: { channel, to, accountId: params.accountId, threadId: params.threadId },
      right: {
        channel: persistedChannel,
        to: normalizeEffectiveReplyTarget(persisted?.to, persistedChannel, persisted?.threadId),
        accountId: persisted?.accountId,
        threadId: persisted?.threadId,
      },
    }),
  );
}

/** Prepares descriptive conversation facts without borrowing execution or sender authority. */
export function prepareReplyConversation(params: {
  ctx: ReplyConversationFields &
    Pick<TemplateContext, "From" | "InternalTurnSource" | "InputProvenance">;
  sessionEntry?: SessionEntry;
  groupResolution?: GroupKeyResolution;
}): PreparedReplyConversation {
  const { ctx, sessionEntry, groupResolution } = params;
  const isSystemEvent = ctx.InternalTurnSource !== undefined;
  const route = isSystemEvent
    ? resolveEffectiveReplyRoute({ ctx, entry: sessionEntry })
    : undefined;
  const persisted = deliveryContextFromSession(sessionEntry);
  const hasCurrentRoute = Boolean(groupResolution || ctx.OriginatingChannel || ctx.OriginatingTo);
  // An explicit different route must lose both stored room names and activation.
  const ownsConversation =
    !isSystemEvent ||
    !hasCurrentRoute ||
    isStoredConversationRoute({
      channel: groupResolution?.channel ?? ctx.OriginatingChannel,
      to: groupResolution?.id ?? ctx.OriginatingTo,
      accountId: ctx.AccountId,
      threadId: ctx.MessageThreadId,
      entry: sessionEntry,
    });
  const conversationEntry = ownsConversation ? sessionEntry : undefined;
  const inherited = isSystemEvent ? conversationEntry : undefined;
  const origin = sessionDeliveryOrigin(inherited);
  const chatType =
    normalizeChatType(ctx.ChatType) ??
    groupResolution?.chatType ??
    normalizeChatType(inherited?.chatType) ??
    normalizeChatType(origin?.chatType);
  const isSharedChat = chatType === "group" || chatType === "channel";
  const fields: ReplyConversationFields = {
    Provider: ctx.Provider,
    Surface: ctx.Surface,
    ChatType: ctx.ChatType,
    OriginatingChannel: ctx.OriginatingChannel,
    OriginatingTo: ctx.OriginatingTo,
    AccountId: ctx.AccountId,
    MessageThreadId: ctx.MessageThreadId,
    GroupSubject: ctx.GroupSubject,
    GroupChannel: ctx.GroupChannel,
    GroupSpace: ctx.GroupSpace,
  };
  if (isSystemEvent) {
    const persistedProvider = normalizePromptRouteChannel(sessionDeliveryChannel(inherited));
    const originatingChannel = normalizePromptRouteChannel(ctx.OriginatingChannel);
    fields.Provider =
      normalizePromptRouteChannel(ctx.Provider) ?? originatingChannel ?? persistedProvider;
    fields.Surface =
      normalizePromptRouteChannel(ctx.Surface) ??
      originatingChannel ??
      normalizePromptRouteChannel(origin?.surface) ??
      persistedProvider;
    fields.ChatType = chatType;
    fields.OriginatingChannel ??= inherited ? (route?.channel ?? persisted?.channel) : undefined;
    fields.OriginatingTo ??= inherited ? (route?.to ?? persisted?.to) : undefined;
    fields.AccountId ??= inherited ? (route?.accountId ?? persisted?.accountId) : undefined;
    fields.MessageThreadId ??= inherited ? (persisted?.threadId ?? origin?.threadId) : undefined;
    fields.GroupSubject =
      normalizeOptionalString(ctx.GroupSubject) ??
      (isSharedChat ? normalizeOptionalString(inherited?.subject) : undefined);
    fields.GroupChannel =
      normalizeOptionalString(ctx.GroupChannel) ??
      (isSharedChat ? normalizeOptionalString(inherited?.groupChannel) : undefined);
    fields.GroupSpace =
      normalizeOptionalString(ctx.GroupSpace) ??
      (isSharedChat ? normalizeOptionalString(inherited?.space) : undefined);
  }
  const channel =
    groupResolution?.channel ??
    (isSystemEvent ? fields.OriginatingChannel : undefined) ??
    fields.Provider;
  const rawGroupId = normalizeOptionalString(ctx.From);
  return {
    fields,
    group: {
      channel,
      groupId: isSystemEvent
        ? normalizeEffectiveReplyTarget(
            inherited?.groupId ?? groupResolution?.id ?? fields.OriginatingTo,
            normalizeMessageChannel(channel),
            fields.MessageThreadId,
          )
        : (groupResolution?.id ?? extractExplicitGroupId(rawGroupId) ?? rawGroupId),
      groupChannel:
        normalizeOptionalString(fields.GroupChannel) ??
        normalizeOptionalString(fields.GroupSubject),
      groupSpace: normalizeOptionalString(fields.GroupSpace),
      accountId: fields.AccountId,
    },
    activation: conversationEntry?.groupActivation,
  };
}
