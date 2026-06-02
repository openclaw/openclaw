import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { CHANNEL_IDS } from "../channels/ids.js";
import { listRegisteredChannelPluginIds } from "../channels/registry.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  type InternalMessageChannel,
} from "./message-channel-constants.js";
import { normalizeMessageChannel as normalizeMessageChannelCore } from "./message-channel-core.js";

type ChannelId = string & { readonly __openclawChannelIdBrand?: never };

export type DeliverableMessageChannel = ChannelId;

export type GatewayMessageChannel = DeliverableMessageChannel;

/** Normalize a raw channel id without requiring the channel to be deliverable. */
export function normalizeMessageChannel(raw?: string | null): string | undefined {
  return normalizeMessageChannelCore(raw);
}

const listPluginChannelIds = (): string[] => {
  return listRegisteredChannelPluginIds();
};

export const listDeliverableMessageChannels = (): ChannelId[] =>
  uniqueStrings([...CHANNEL_IDS, ...listPluginChannelIds()]) as ChannelId[];

/** Gateway traffic may use deliverable channels or the internal webchat channel. */
const listGatewayMessageChannels = (): GatewayMessageChannel[] => [
  ...listDeliverableMessageChannels(),
  INTERNAL_MESSAGE_CHANNEL,
];

/** Return whether a normalized channel is accepted as a gateway message source. */
export function isGatewayMessageChannel(value: string): value is GatewayMessageChannel {
  return listGatewayMessageChannels().includes(value as GatewayMessageChannel);
}

/** Return whether a normalized channel maps to a deliverable built-in or plugin channel. */
export function isDeliverableMessageChannel(value: string): value is DeliverableMessageChannel {
  return listDeliverableMessageChannels().includes(value as DeliverableMessageChannel);
}

/** Normalize and validate a raw gateway message-channel hint. */
export function resolveGatewayMessageChannel(
  raw?: string | null,
): GatewayMessageChannel | undefined {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized) {
    return undefined;
  }
  return isGatewayMessageChannel(normalized) ? normalized : undefined;
}

/** Resolve the first non-empty normalized channel from primary/fallback inputs. */
export function resolveMessageChannel(
  primary?: string | null,
  fallback?: string | null,
): string | undefined {
  return normalizeMessageChannel(primary) ?? normalizeMessageChannel(fallback);
}

export type { InternalMessageChannel };
