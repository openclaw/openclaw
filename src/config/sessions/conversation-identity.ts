import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import {
  buildConversationRef,
  normalizeConversationPeerId,
} from "../../routing/conversation-ref.js";
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

/** Stable transport address independent from the local session holding model context. */
export type ConversationIdentity = {
  conversationRef: string;
  channel: string;
  accountId: string;
  kind: ConversationKind;
  peerId: string;
  deliveryTarget: string;
  parentConversationRef?: string;
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

function finalizeConversationIdentity(params: {
  channel?: string;
  accountId?: string;
  kind: ConversationKind;
  peerId?: string;
  deliveryTarget?: string;
  parentConversationRef?: string;
  threadId?: string | number;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}): ConversationIdentity | null {
  const channel = normalizeText(params.channel)?.toLowerCase();
  const rawPeerId = normalizeText(params.peerId);
  if (!channel || !rawPeerId) {
    return null;
  }
  const peerId = normalizeConversationPeerId(channel, rawPeerId);
  if (!peerId) {
    return null;
  }
  // A normalized peer id identifies a conversation but is not necessarily a
  // routable transport address. Exact-address tools require authoritative egress facts.
  const deliveryTarget = normalizeText(params.deliveryTarget);
  if (!deliveryTarget) {
    return null;
  }
  const accountId = normalizeAccountId(params.accountId) ?? "default";
  const rawParent = normalizeText(params.parentConversationRef);
  const parentConversationRef = rawParent
    ? rawParent.startsWith("conv_")
      ? rawParent
      : buildConversationRef({
          channel,
          accountId,
          kind: params.kind,
          peerId: normalizeConversationPeerId(channel, rawParent),
        })
    : undefined;
  const threadId = normalizeThreadId(params.threadId);
  return {
    conversationRef: buildConversationRef({
      channel,
      accountId,
      kind: params.kind,
      peerId,
      parentConversationRef,
      threadId,
    }),
    channel,
    accountId,
    kind: params.kind,
    peerId,
    deliveryTarget,
    ...(parentConversationRef ? { parentConversationRef } : {}),
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

/** Derives a transport address from the canonical route snapshot persisted on a session. */
export function conversationIdentityFromSessionEntry(
  entry: SessionEntry,
): ConversationIdentity | null {
  // Explicit route snapshots own their populated fields, while persisted
  // origin/last-route facts fill gaps such as an omitted account id.
  const deliveryContext = mergeDeliveryContext(
    normalizeDeliveryContext(entry.deliveryContext),
    deliveryContextFromSession(entry),
  );
  const kind = normalizeKind(entry.chatType);
  const channel = deliveryContext?.channel ?? normalizeText(entry.channel);
  const peerId =
    kind === "direct"
      ? (normalizeText(entry.origin?.nativeDirectUserId) ?? deliveryContextPeerId(deliveryContext))
      : (normalizeText(entry.groupId) ??
        normalizeText(entry.origin?.nativeChannelId) ??
        deliveryContextPeerId(deliveryContext));
  return finalizeConversationIdentity({
    channel,
    accountId: deliveryContext?.accountId,
    kind,
    peerId,
    deliveryTarget:
      kind === "direct"
        ? (deliveryContextPeerId(deliveryContext) ?? normalizeText(entry.origin?.from))
        : deliveryContextPeerId(deliveryContext),
    threadId: deliveryContext?.threadId,
    nativeChannelId: entry.origin?.nativeChannelId,
    nativeDirectUserId: entry.origin?.nativeDirectUserId,
    label: entry.displayName ?? entry.label,
  });
}

/** Derives the same stable address from live inbound channel facts. */
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
    deliveryTarget:
      kind === "direct"
        ? (normalizeText(params.ctx.From) ?? deliveryContextPeerId(deliveryContext))
        : (deliveryContextPeerId(deliveryContext) ??
          normalizeText(params.ctx.OriginatingTo) ??
          normalizeText(params.ctx.To)),
    threadId: deliveryContext?.threadId ?? params.ctx.MessageThreadId,
    nativeChannelId: params.ctx.NativeChannelId ?? route?.nativeChannelId,
    nativeDirectUserId: params.ctx.NativeDirectUserId ?? route?.nativeDirectUserId,
    label: normalizeText(resolveConversationLabel(params.ctx)) ?? route?.label,
  });
}
