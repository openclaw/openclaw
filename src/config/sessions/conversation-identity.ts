import crypto from "node:crypto";
import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import { normalizeAccountId } from "../../utils/account-id.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { resolveGroupSessionKey } from "./group.js";
import { deriveSessionOrigin } from "./metadata.js";
import type { GroupKeyResolution, SessionEntry } from "./types.js";

export type ConversationKind = "channel" | "direct" | "group";

export type ConversationIdentity = {
  conversationId: string;
  channel: string;
  accountId: string;
  kind: ConversationKind;
  peerId: string;
  parentConversationId?: string;
  threadId?: string;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  label?: string;
  metadata?: Record<string, unknown>;
};

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return normalizeText(value);
}

function normalizeKind(value: unknown): ConversationKind {
  const normalized = normalizeChatType(typeof value === "string" ? value : undefined);
  if (normalized === "channel") {
    return "channel";
  }
  if (normalized === "group") {
    return "group";
  }
  return "direct";
}

function buildConversationId(params: {
  channel: string;
  accountId: string;
  kind: ConversationKind;
  peerId: string;
  parentConversationId?: string;
  threadId?: string;
}): string {
  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        params.channel,
        params.accountId,
        params.kind,
        params.peerId,
        params.parentConversationId ?? "",
        params.threadId ?? "",
      ]),
    )
    .digest("hex")
    .slice(0, 32);
  return `conv_${hash}`;
}

function finalizeConversationIdentity(params: {
  channel?: string;
  accountId?: string;
  kind: ConversationKind;
  peerId?: string;
  parentConversationId?: string;
  threadId?: string;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}): ConversationIdentity | null {
  const channel = normalizeText(params.channel);
  const peerId = normalizeText(params.peerId);
  if (!channel || !peerId) {
    return null;
  }
  const accountId = normalizeAccountId(params.accountId) ?? "default";
  const parentConversationId = normalizeText(params.parentConversationId);
  const threadId = normalizeThreadId(params.threadId);
  return {
    conversationId: buildConversationId({
      channel,
      accountId,
      kind: params.kind,
      peerId,
      parentConversationId,
      threadId,
    }),
    channel,
    accountId,
    kind: params.kind,
    peerId,
    ...(parentConversationId ? { parentConversationId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(normalizeText(params.nativeChannelId)
      ? { nativeChannelId: normalizeText(params.nativeChannelId) }
      : {}),
    ...(normalizeText(params.nativeDirectUserId)
      ? { nativeDirectUserId: normalizeText(params.nativeDirectUserId) }
      : {}),
    ...(normalizeText(params.label) ? { label: normalizeText(params.label) } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
}

function deliveryContextPeerId(context: DeliveryContext | undefined): string | undefined {
  return normalizeText(context?.to);
}

export function conversationIdentityFromSessionEntry(
  entry: SessionEntry,
): ConversationIdentity | null {
  const deliveryContext = deliveryContextFromSession(entry);
  const kind = normalizeKind(entry.chatType);
  const channel = deliveryContext?.channel ?? normalizeText(entry.channel);
  const peerId =
    kind === "direct"
      ? (normalizeText(entry.nativeDirectUserId) ?? deliveryContextPeerId(deliveryContext))
      : (normalizeText(entry.groupId) ??
        normalizeText(entry.nativeChannelId) ??
        deliveryContextPeerId(deliveryContext));
  return finalizeConversationIdentity({
    channel,
    accountId: deliveryContext?.accountId,
    kind,
    peerId,
    threadId: normalizeThreadId(deliveryContext?.threadId),
    nativeChannelId: entry.nativeChannelId,
    nativeDirectUserId: entry.nativeDirectUserId,
    label: entry.displayName ?? entry.label,
  });
}

export function conversationIdentityFromMsgContext(params: {
  ctx: MsgContext;
  deliveryContext?: DeliveryContext;
  groupResolution?: GroupKeyResolution | null;
}): ConversationIdentity | null {
  const route = deriveSessionOrigin(params.ctx);
  const deliveryContext = mergeDeliveryContext(
    normalizeDeliveryContext(params.deliveryContext),
    normalizeDeliveryContext({
      channel: route?.provider,
      to: route?.to,
      accountId: route?.accountId,
      threadId: route?.threadId,
    }),
  );
  const groupResolution = params.groupResolution ?? resolveGroupSessionKey(params.ctx);
  const kind = groupResolution?.chatType ?? normalizeKind(params.ctx.ChatType);
  const channel =
    deliveryContext?.channel ??
    groupResolution?.channel ??
    normalizeText(route?.provider) ??
    normalizeText(params.ctx.OriginatingChannel) ??
    normalizeText(params.ctx.Provider);
  const peerId =
    kind === "direct"
      ? (normalizeText(params.ctx.NativeDirectUserId) ??
        deliveryContextPeerId(deliveryContext) ??
        normalizeText(params.ctx.OriginatingTo) ??
        normalizeText(params.ctx.To) ??
        normalizeText(params.ctx.From))
      : (normalizeText(groupResolution?.id) ??
        deliveryContextPeerId(deliveryContext) ??
        normalizeText(params.ctx.OriginatingTo) ??
        normalizeText(params.ctx.To) ??
        normalizeText(params.ctx.From));
  return finalizeConversationIdentity({
    channel,
    accountId: deliveryContext?.accountId ?? route?.accountId ?? params.ctx.AccountId,
    kind,
    peerId,
    parentConversationId: normalizeText(params.ctx.ThreadParentId),
    threadId: normalizeThreadId(deliveryContext?.threadId ?? params.ctx.MessageThreadId),
    nativeChannelId: params.ctx.NativeChannelId ?? route?.nativeChannelId,
    nativeDirectUserId: params.ctx.NativeDirectUserId ?? route?.nativeDirectUserId,
    label: normalizeText(resolveConversationLabel(params.ctx)) ?? route?.label,
  });
}
