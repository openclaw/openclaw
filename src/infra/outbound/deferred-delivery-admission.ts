// Resolves provider-owned admission before outbound intents are persisted or replayed.
import type {
  ChannelMessageDeferredDeliveryAdmissionContext,
  ChannelMessageDeferredDeliveryAdmissionResult,
} from "../../channels/message/types.js";
import { resolveOutboundChannelMessageAdapter } from "./channel-resolution.js";

export async function prepareDeferredDeliveryAdmission(
  params: ChannelMessageDeferredDeliveryAdmissionContext,
  owner?: { agentId?: string; assertCurrent?: () => void },
): Promise<() => ChannelMessageDeferredDeliveryAdmissionResult> {
  const adapter = await resolveOutboundChannelMessageAdapter({
    channel: params.channel,
    cfg: params.cfg,
    agentId: owner?.agentId,
    allowBootstrap: true,
    assertCurrent: owner?.assertCurrent,
  });
  // Recovery rechecks its continuation fence after preparation and before provider policy runs.
  return () => {
    owner?.assertCurrent?.();
    return adapter?.durableFinal?.admitDeferredDelivery?.(params) ?? { status: "allowed" };
  };
}
