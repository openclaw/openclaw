/**
 * Channel pairing registry facade.
 *
 * Lists pairing-capable channels and dispatches approval notifications through adapters.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ChannelId } from "./channel-id.types.js";
import type { ChannelPairingAdapter } from "./pairing.types.js";
import { getChannelPlugin, listChannelPlugins } from "./registry.js";

function readPairingAdapter(plugin: {
  pairing?: ChannelPairingAdapter;
}): ChannelPairingAdapter | null {
  try {
    return plugin.pairing ?? null;
  } catch {
    return null;
  }
}

export function listPairingChannels(): ChannelId[] {
  // Channel docking: pairing support is declared via plugin.pairing.
  return listChannelPlugins()
    .filter((plugin) => readPairingAdapter(plugin))
    .map((plugin) => plugin.id);
}

export function getPairingAdapter(channelId: ChannelId): ChannelPairingAdapter | null {
  const plugin = getChannelPlugin(channelId);
  return plugin ? readPairingAdapter(plugin) : null;
}

export function requirePairingAdapter(channelId: ChannelId): ChannelPairingAdapter {
  const adapter = getPairingAdapter(channelId);
  if (!adapter) {
    throw new Error(`Channel ${channelId} does not support pairing`);
  }
  return adapter;
}

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
