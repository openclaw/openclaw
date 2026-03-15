import type { ChannelId } from "../channels/plugins/types.js";
import {
  CHANNEL_IDS,
  listChatChannelAliases,
  normalizeChatChannelId,
} from "../channels/registry.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
  normalizeGatewayClientMode,
  normalizeGatewayClientName,
} from "../gateway/protocol/client-info.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";

export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;
export type InternalMessageChannel = typeof INTERNAL_MESSAGE_CHANNEL;

/**
 * Sentinel channel used when sessions_send injects a message into a target
 * session. Distinct from INTERNAL_MESSAGE_CHANNEL so that resolveLastChannelRaw
 * does NOT flip the receiver's route to webchat. Instead it falls through to
 * the persisted external channel, preserving the receiver's established route.
 */
export const INTER_SESSION_CHANNEL = "inter_session" as const;
export type InterSessionChannel = typeof INTER_SESSION_CHANNEL;

/**
 * Channel IDs that are reserved for internal OpenClaw routing.
 * No plugin may register a channel with these IDs — doing so would shadow
 * a sentinel value and silently break cross-session message delivery.
 * Checked in both plugin install (validatePluginId) and runtime channel
 * registration (registerChannel) to cover all registration paths.
 */
const RESERVED_CHANNEL_IDS: ReadonlySet<string> = new Set([
  INTER_SESSION_CHANNEL,
  INTERNAL_MESSAGE_CHANNEL,
]);

export function isReservedChannelId(raw?: unknown): boolean {
  if (typeof raw !== "string") {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return Boolean(normalized) && RESERVED_CHANNEL_IDS.has(normalized);
}

export function listReservedChannelIds(): string[] {
  return Array.from(RESERVED_CHANNEL_IDS);
}

export function isInterSessionChannel(raw?: string | null): boolean {
  // Guard against collision with real deliverable plugin channels: a plugin
  // could theoretically register a channel named "inter_session", which must
  // not be silently treated as our sentinel.
  if (raw?.trim().toLowerCase() !== INTER_SESSION_CHANNEL) {
    return false;
  }
  return !isDeliverableMessageChannel(INTER_SESSION_CHANNEL);
}

const MARKDOWN_CAPABLE_CHANNELS = new Set<string>([
  "slack",
  "telegram",
  "signal",
  "discord",
  "googlechat",
  "tui",
  INTERNAL_MESSAGE_CHANNEL,
]);

export { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES };
export type { GatewayClientName, GatewayClientMode };
export { normalizeGatewayClientName, normalizeGatewayClientMode };

type GatewayClientInfoLike = {
  mode?: string | null;
  id?: string | null;
};

export function isGatewayCliClient(client?: GatewayClientInfoLike | null): boolean {
  return normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.CLI;
}

export function isInternalMessageChannel(raw?: string | null): raw is InternalMessageChannel {
  return normalizeMessageChannel(raw) === INTERNAL_MESSAGE_CHANNEL;
}

export function isWebchatClient(client?: GatewayClientInfoLike | null): boolean {
  const mode = normalizeGatewayClientMode(client?.mode);
  if (mode === GATEWAY_CLIENT_MODES.WEBCHAT) {
    return true;
  }
  return normalizeGatewayClientName(client?.id) === GATEWAY_CLIENT_NAMES.WEBCHAT_UI;
}

export function normalizeMessageChannel(raw?: string | null): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (isReservedChannelId(normalized)) {
    return normalized;
  }
  const builtIn = normalizeChatChannelId(normalized);
  if (builtIn) {
    return builtIn;
  }
  const registry = getActivePluginRegistry();
  const pluginMatch = registry?.channels.find((entry) => {
    if (entry.plugin.id.toLowerCase() === normalized) {
      return true;
    }
    return (entry.plugin.meta.aliases ?? []).some(
      (alias) => typeof alias === "string" && alias.trim().toLowerCase() === normalized,
    );
  });
  return pluginMatch?.plugin.id ?? normalized;
}

const listPluginChannelIds = (): string[] => {
  const registry = getActivePluginRegistry();
  if (!registry) {
    return [];
  }
  return registry.channels.map((entry) => entry.plugin.id);
};

const listPluginChannelAliases = (): string[] => {
  const registry = getActivePluginRegistry();
  if (!registry) {
    return [];
  }
  return registry.channels.flatMap((entry) =>
    (entry.plugin.meta.aliases ?? []).filter((alias): alias is string => typeof alias === "string"),
  );
};

export const listDeliverableMessageChannels = (): ChannelId[] =>
  Array.from(new Set([...CHANNEL_IDS, ...listPluginChannelIds()]));

export type DeliverableMessageChannel = ChannelId;

export type GatewayMessageChannel =
  | DeliverableMessageChannel
  | InternalMessageChannel
  | InterSessionChannel;

// NOTE: INTER_SESSION_CHANNEL is intentionally excluded from the runtime list.
// It exists in the GatewayMessageChannel type so internal tools can use it,
// but it must not be accepted from external RPC callers or the delivery path.
// isGatewayMessageChannel("inter_session") → false by design.
export const listGatewayMessageChannels = (): GatewayMessageChannel[] => [
  ...listDeliverableMessageChannels(),
  INTERNAL_MESSAGE_CHANNEL,
];

export const listGatewayAgentChannelAliases = (): string[] =>
  Array.from(new Set([...listChatChannelAliases(), ...listPluginChannelAliases()]));

export type GatewayAgentChannelHint = GatewayMessageChannel | "last";

export const listGatewayAgentChannelValues = (): string[] =>
  Array.from(
    new Set([...listGatewayMessageChannels(), "last", ...listGatewayAgentChannelAliases()]),
  );

export function isGatewayMessageChannel(value: string): value is GatewayMessageChannel {
  return listGatewayMessageChannels().includes(value as GatewayMessageChannel);
}

export function isDeliverableMessageChannel(value: string): value is DeliverableMessageChannel {
  return listDeliverableMessageChannels().includes(value as DeliverableMessageChannel);
}

export function resolveGatewayMessageChannel(
  raw?: string | null,
): GatewayMessageChannel | undefined {
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

export function isMarkdownCapableMessageChannel(raw?: string | null): boolean {
  const channel = normalizeMessageChannel(raw);
  if (!channel) {
    return false;
  }
  return MARKDOWN_CAPABLE_CHANNELS.has(channel);
}
