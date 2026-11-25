import { getLoadedChannelPlugin } from "./plugins/index.js";
import type { ChannelThreadingAdapter } from "./plugins/types.core.js";

/** Returns the loaded channel's threading adapter without bundled fallback discovery. */
export function getLoadedChannelThreadingAdapter(
  channel?: string | null,
): ChannelThreadingAdapter | undefined {
  if (!channel) {
    return undefined;
  }
  return getLoadedChannelPlugin(channel)?.threading;
}

/** Resolves where a loaded channel transport keeps thread identity. */
export function resolveChannelThreadAddressing(channel?: string | null): "address" | "message" {
  return getLoadedChannelThreadingAdapter(channel)?.threadAddressing ?? "address";
}
