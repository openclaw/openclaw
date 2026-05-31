import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getBundledChannelAccountInspector } from "./plugins/bundled.js";
import { getLoadedChannelPlugin } from "./plugins/registry.js";
import type { ChannelId } from "./plugins/types.public.js";

export type ReadOnlyInspectedAccount = Record<string, unknown>;

/** Inspect a channel account without starting or mutating the channel runtime. */
export async function inspectReadOnlyChannelAccount(params: {
  channelId: ChannelId;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<ReadOnlyInspectedAccount | null> {
  const inspectAccount =
    getLoadedChannelPlugin(params.channelId)?.config.inspectAccount ??
    getBundledChannelAccountInspector(params.channelId);
  if (!inspectAccount) {
    return null;
  }
  return (await Promise.resolve(
    inspectAccount(params.cfg, params.accountId),
  )) as ReadOnlyInspectedAccount | null;
}
