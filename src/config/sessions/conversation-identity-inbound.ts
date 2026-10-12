import { normalizeOptionalString as normalizeText } from "@openclaw/normalization-core/string-coerce";
import { normalizeInternalTurnContext } from "../../auto-reply/internal-turn-source.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { buildConversationIdentity, type ConversationIdentity } from "./conversation-identity.js";
import { conversationRouteContextFromMsgContext } from "./conversation-route-context.js";
import { resolveGroupSessionKey } from "./group.js";
import { deriveSessionOrigin } from "./metadata.js";
import type { GroupKeyResolution } from "./types.js";

/** Derives the same stable address from live inbound channel facts. */
export function conversationIdentityFromMsgContext(params: {
  ctx: MsgContext;
  deliveryContext?: DeliveryContext;
  groupResolution?: GroupKeyResolution | null;
}): ConversationIdentity | null {
  normalizeInternalTurnContext(params.ctx);
  const route = deriveSessionOrigin(params.ctx);
  const explicitDeliveryContext = normalizeDeliveryContext(params.deliveryContext);
  const deliveryContext = mergeDeliveryContext(explicitDeliveryContext, {
    channel: route?.provider,
    to: route?.to,
    accountId: route?.accountId,
    threadId: route?.threadId,
  });
  // A synthetic turn has no transport sender. Its host-prepared originating route
  // is paired delivery, while From can be an allowlist identity used for execution.
  const pairedDeliveryContext =
    explicitDeliveryContext ??
    (params.ctx.InternalTurnSource && params.ctx.OriginatingChannel && params.ctx.OriginatingTo
      ? deliveryContext
      : undefined);
  const groupResolution = params.groupResolution ?? resolveGroupSessionKey(params.ctx);
  const routeContext = conversationRouteContextFromMsgContext(params.ctx);
  const kind =
    groupResolution?.chatType ??
    normalizeChatType(typeof params.ctx.ChatType === "string" ? params.ctx.ChatType : undefined) ??
    "direct";
  const directIngressTarget = kind === "direct" ? normalizeText(params.ctx.From) : undefined;
  // An explicit delivery context is already a paired route. Otherwise direct ingress
  // addresses the sender (`From`), while OriginatingTo can describe the local endpoint.
  const useDirectIngressTarget = Boolean(directIngressTarget && !pairedDeliveryContext?.to);
  const deliveryTarget = useDirectIngressTarget
    ? directIngressTarget
    : (normalizeText(deliveryContext?.to) ??
      normalizeText(params.ctx.OriginatingTo) ??
      normalizeText(params.ctx.To));
  const channel = useDirectIngressTarget
    ? (normalizeText(route?.provider) ??
      normalizeText(params.ctx.OriginatingChannel) ??
      normalizeText(params.ctx.Provider))
    : (deliveryContext?.channel ??
      groupResolution?.channel ??
      normalizeText(route?.provider) ??
      normalizeText(params.ctx.OriginatingChannel) ??
      normalizeText(params.ctx.Provider));
  return buildConversationIdentity({
    channel,
    accountId: useDirectIngressTarget
      ? (route?.accountId ?? params.ctx.AccountId)
      : (deliveryContext?.accountId ?? route?.accountId ?? params.ctx.AccountId),
    kind,
    peerId: routeContext?.peerId ?? deliveryTarget,
    deliveryTarget,
    threadId: useDirectIngressTarget
      ? (route?.threadId ?? params.ctx.MessageThreadId)
      : (deliveryContext?.threadId ?? params.ctx.MessageThreadId),
    nativeChannelId: params.ctx.NativeChannelId ?? route?.nativeChannelId,
    nativeDirectUserId: params.ctx.NativeDirectUserId ?? route?.nativeDirectUserId,
    label: normalizeText(resolveConversationLabel(params.ctx)) ?? route?.label,
  });
}
