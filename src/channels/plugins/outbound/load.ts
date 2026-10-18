import type { ChannelOutboundAdapter } from "../outbound.types.js";
import { createChannelRegistryLoader } from "../registry-loader.js";

export const loadChannelOutboundAdapter = createChannelRegistryLoader<ChannelOutboundAdapter>(
  (entry) => entry.plugin.outbound,
);
