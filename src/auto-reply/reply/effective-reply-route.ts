import type { SessionEntry } from "../../config/sessions/types.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import type { FinalizedMsgContext } from "../templating.js";

export type EffectiveReplyRouteContext = Pick<
  FinalizedMsgContext,
  "Provider" | "Surface" | "OriginatingChannel" | "OriginatingTo" | "AccountId" | "InputProvenance"
>;

export type EffectiveReplyRouteEntry = Pick<
  SessionEntry,
  "deliveryContext" | "lastChannel" | "lastTo" | "lastAccountId"
>;

export type EffectiveReplyRoute = {
  channel?: string;
  to?: string;
  accountId?: string;
  inheritedExternalRoute?: boolean;
};

export function isSystemEventProvider(provider?: string): boolean {
  return provider === "heartbeat" || provider === "cron-event" || provider === "exec-event";
}

function isSessionsSendInterSessionHandoff(inputProvenance: InputProvenance | undefined): boolean {
  return (
    inputProvenance?.kind === "inter_session" &&
    inputProvenance.sourceTool?.toLowerCase() === "sessions_send"
  );
}

export function resolveEffectiveReplyRoute(params: {
  ctx: EffectiveReplyRouteContext;
  entry?: EffectiveReplyRouteEntry;
}): EffectiveReplyRoute {
  const currentSurface =
    normalizeMessageChannel(params.ctx.Provider) ??
    normalizeMessageChannel(params.ctx.Surface) ??
    normalizeMessageChannel(params.ctx.OriginatingChannel);
  const persistedDeliveryContext = params.entry?.deliveryContext;
  const persistedDeliveryChannel = normalizeMessageChannel(persistedDeliveryContext?.channel);
  if (
    isSessionsSendInterSessionHandoff(params.ctx.InputProvenance) &&
    currentSurface === INTERNAL_MESSAGE_CHANNEL &&
    persistedDeliveryChannel &&
    persistedDeliveryChannel !== INTERNAL_MESSAGE_CHANNEL &&
    isDeliverableMessageChannel(persistedDeliveryChannel) &&
    persistedDeliveryContext?.to
  ) {
    return {
      channel: persistedDeliveryChannel,
      to: persistedDeliveryContext.to,
      accountId: persistedDeliveryContext.accountId,
      inheritedExternalRoute: true,
    };
  }
  if (!isSystemEventProvider(params.ctx.Provider)) {
    return {
      channel: params.ctx.OriginatingChannel,
      to: params.ctx.OriginatingTo,
      accountId: params.ctx.AccountId,
    };
  }
  return {
    channel:
      params.ctx.OriginatingChannel ??
      persistedDeliveryContext?.channel ??
      params.entry?.lastChannel,
    to: params.ctx.OriginatingTo ?? persistedDeliveryContext?.to ?? params.entry?.lastTo,
    accountId:
      params.ctx.AccountId ?? persistedDeliveryContext?.accountId ?? params.entry?.lastAccountId,
  };
}
