import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { CHANNEL_IDS } from "../channels/ids.js";
import { listRegisteredChannelPluginIds } from "../channels/registry.js";
import { INTERNAL_MESSAGE_CHANNEL } from "./message-channel-constants.js";
import { normalizeMessageChannel } from "./message-channel-core.js";
export { normalizeMessageChannel } from "./message-channel-core.js";

export const listDeliverableMessageChannels = (): string[] =>
  uniqueStrings([...CHANNEL_IDS, ...listRegisteredChannelPluginIds()]);

export function isGatewayMessageChannel(value: string): boolean {
  return value === INTERNAL_MESSAGE_CHANNEL || isDeliverableMessageChannel(value);
}

export function isDeliverableMessageChannel(value: string): boolean {
  return (
    CHANNEL_IDS.some((channelId) => channelId === value) ||
    listRegisteredChannelPluginIds().includes(value)
  );
}

export function resolveGatewayMessageChannel(raw?: string | null): string | undefined {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized) {
    return undefined;
  }
  return isGatewayMessageChannel(normalized) ? normalized : undefined;
}

export function resolveMessageChannel(
  primary?: string | null,
  fallback?: string | null,
): string | undefined {
  return normalizeMessageChannel(primary) ?? normalizeMessageChannel(fallback);
}
