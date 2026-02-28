import type { ChannelOutboundAdapter } from "../types.js";

export type OutboundAdapterNormalization = {
  adapter: ChannelOutboundAdapter;
  supportsIdempotencyKey: boolean;
};

/**
 * Validate that an outbound adapter is present and return it with metadata.
 * Since sendFinal is required on ChannelOutboundAdapter, no inference needed.
 */
export function normalizeChannelOutboundAdapter(params: {
  channelId: string;
  adapter?: ChannelOutboundAdapter;
}): OutboundAdapterNormalization | undefined {
  if (!params.adapter) {
    return undefined;
  }
  return {
    adapter: params.adapter,
    supportsIdempotencyKey: params.adapter.supportsIdempotencyKey === true,
  };
}
