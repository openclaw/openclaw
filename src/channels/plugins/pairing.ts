import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ChannelId } from "./channel-id.types.js";
import type { ChannelPairingAdapter } from "./pairing.types.js";
import { getChannelPlugin, listChannelPlugins } from "./registry.js";

/** Lists loaded channel ids that expose a pairing adapter. */
export function listPairingChannels(): ChannelId[] {
  // Channel docking: pairing support is declared via plugin.pairing.
  return listChannelPlugins()
    .filter((plugin) => plugin.pairing)
    .map((plugin) => plugin.id);
}

/** Returns the pairing adapter for a loaded channel, if pairing is supported. */
export function getPairingAdapter(channelId: ChannelId): ChannelPairingAdapter | null {
  const plugin = getChannelPlugin(channelId);
  return plugin?.pairing ?? null;
}

/** Returns a channel pairing adapter or throws a setup-facing unsupported error. */
export function requirePairingAdapter(channelId: ChannelId): ChannelPairingAdapter {
  const adapter = getPairingAdapter(channelId);
  if (!adapter) {
    throw new Error(`Channel ${channelId} does not support pairing`);
  }
  return adapter;
}

/** Notifies a channel after a pairing request is approved. */
export async function notifyPairingApproved(params: {
  channelId: ChannelId;
  id: string;
  cfg: OpenClawConfig;
  accountId?: string;
  runtime?: RuntimeEnv;
  /** Extension channels can pass their adapter directly to bypass registry lookup. */
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<void> {
  // Extensions may provide adapter directly to bypass ESM module isolation
  const adapter = params.pairingAdapter ?? requirePairingAdapter(params.channelId);
  if (!adapter.notifyApproval) {
    return;
  }
  await adapter.notifyApproval({
    cfg: params.cfg,
    id: params.id,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    runtime: params.runtime,
  });
}
