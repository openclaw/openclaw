import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ChannelId } from "./channel-id.types.js";
import { PAIRING_APPROVED_MESSAGE } from "./pairing-message.js";
import type { ChannelPairingAdapter } from "./pairing.types.js";
import { getChannelPlugin, listChannelPlugins } from "./registry.js";

export function listPairingChannels(): ChannelId[] {
  // Channel docking: pairing support is declared via plugin.pairing.
  return listChannelPlugins()
    .filter((plugin) => plugin.pairing)
    .map((plugin) => plugin.id);
}

export function getPairingAdapter(channelId: ChannelId): ChannelPairingAdapter | null {
  const plugin = getChannelPlugin(channelId);
  return plugin?.pairing ?? null;
}

export async function notifyPairingApproved(params: {
  channelId: ChannelId;
  id: string;
  cfg: OpenClawConfig;
  accountId?: string;
  meta?: Record<string, string>;
  runtime?: RuntimeEnv;
  /** Extension channels can pass their adapter directly to bypass registry lookup. */
  pairingAdapter?: ChannelPairingAdapter;
  /** Use the active transport when already executing inside the Gateway. */
  gatewayOwnedDelivery?: boolean;
}): Promise<"sent" | "unsupported"> {
  const { channelId, pairingAdapter, gatewayOwnedDelivery, ...notification } = params;
  const adapter = pairingAdapter ?? getPairingAdapter(channelId);
  if (!adapter) {
    throw new Error(`Channel ${channelId} does not support pairing`);
  }
  if (adapter.notifyApproval) {
    await adapter.notifyApproval(notification);
  } else {
    const plugin = getChannelPlugin(channelId);
    if (!plugin?.outbound?.sendText) {
      return "unsupported";
    }
    const { sendMessage } = await import("../../infra/outbound/message.js");
    const result = await sendMessage({
      cfg: params.cfg,
      to: params.id,
      accountId: params.accountId,
      content: PAIRING_APPROVED_MESSAGE,
      preparedPlugin: plugin,
      gatewayOwnedDelivery,
    });
    if (result.deliveryStatus === "suppressed") {
      throw new Error("Pairing approval notification was suppressed");
    }
  }
  return "sent";
}
