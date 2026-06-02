import type { ChannelId } from "../channel-id.types.js";
import type { ChannelOutboundAdapter } from "../outbound.types.js";

/** Lazy outbound adapter loader contract used by delivery paths. */
export type LoadChannelOutboundAdapter = (
  id: ChannelId,
) => Promise<ChannelOutboundAdapter | undefined>;
