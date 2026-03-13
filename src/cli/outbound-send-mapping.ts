import type { OutboundSendDeps } from "../infra/outbound/deliver.js";

/**
 * CLI-internal send function sources, keyed by channel ID.
 * Each value is a lazily-loaded send function for that channel.
 */
export type CliOutboundSendSource = { [channelId: string]: unknown };

/**
 * Pass CLI send sources through as-is — both CliOutboundSendSource and
 * OutboundSendDeps are now channel-ID-keyed records.
 */
export function createOutboundSendDepsFromCliSource(deps: CliOutboundSendSource): OutboundSendDeps {
  return { ...deps };
}
