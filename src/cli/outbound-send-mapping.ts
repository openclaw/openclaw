import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeChannelId } from "../channels/registry.js";
import {
  resolveLegacyOutboundSendDepKeys,
  type OutboundSendDeps,
} from "../infra/outbound/send-deps.js";

/**
 * CLI-internal send function sources, keyed by channel ID.
 * Each value is a lazily-loaded send function for that channel.
 */
export const CLI_OUTBOUND_SEND_FACTORY: unique symbol = Symbol.for(
  "openclaw.cliOutboundSendFactory",
) as never;

type CliOutboundSendFactory = (channelId: string) => unknown;
export type CliOutboundSendSource = {
  [channelId: string]: unknown;
  [CLI_OUTBOUND_SEND_FACTORY]?: CliOutboundSendFactory;
};

function normalizeLegacyChannelStem(raw: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(
    raw
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/_/g, "-")
      .trim(),
  );
  return normalized.replace(/-/g, "");
}

function resolveChannelIdFromLegacySourceKey(key: string): string | undefined {
  const match = key.match(/^sendMessage(.+)$/);
  if (!match) {
    return undefined;
  }
  const normalizedStem = normalizeLegacyChannelStem(match[1] ?? "");
  return normalizedStem || undefined;
}

function resolveChannelIdFromLegacyOutboundKey(key: string): string | undefined {
  const match = key.match(/^send(.+)$/);
  if (!match) {
    return undefined;
  }
  const normalizedStem = normalizeLegacyChannelStem(match[1] ?? "");
  return normalizedStem || undefined;
}

function resolveKnownChannelId(raw: string): string | undefined {
  return normalizeChannelId(raw) ?? undefined;
}

/** Converts CLI channel send sources into runtime outbound send dependencies. */
export function createOutboundSendDepsFromCliSource(deps: CliOutboundSendSource): OutboundSendDeps {
  const outbound: OutboundSendDeps = { ...deps };
  const sendFactory = deps[CLI_OUTBOUND_SEND_FACTORY];

  for (const legacySourceKey of Object.keys(deps)) {
    const channelId = resolveChannelIdFromLegacySourceKey(legacySourceKey);
    if (!channelId) {
      continue;
    }
    const sourceValue = deps[legacySourceKey];
    if (sourceValue !== undefined && outbound[channelId] === undefined) {
      // Accept old sendMessageTelegram-style CLI mocks while keeping channel IDs canonical.
      outbound[channelId] = sourceValue;
    }
  }

  for (const channelId of Object.keys(outbound)) {
    const sourceValue = outbound[channelId];
    if (sourceValue === undefined) {
      continue;
    }
    for (const legacyDepKey of resolveLegacyOutboundSendDepKeys(channelId)) {
      // Runtime callers may still request sendTelegram-style dependency names.
      if (outbound[legacyDepKey] === undefined) {
        outbound[legacyDepKey] = sourceValue;
      }
    }
  }

  if (!sendFactory) {
    return outbound;
  }

  const resolveFactoryValue = (key: string): unknown => {
    const candidate =
      outbound[key] === undefined ? (resolveChannelIdFromLegacyOutboundKey(key) ?? key) : key;
    const channelId = resolveKnownChannelId(candidate);
    if (!channelId || channelId === "then" || channelId === "toJSON") {
      // Avoid promise/JSON protocol probes causing lazy channel imports.
      return undefined;
    }
    const value = sendFactory(channelId);
    if (value !== undefined) {
      outbound[channelId] = value;
      for (const legacyDepKey of resolveLegacyOutboundSendDepKeys(channelId)) {
        outbound[legacyDepKey] ??= value;
      }
    }
    return value;
  };

  return new Proxy(outbound, {
    get(target, property, receiver) {
      if (typeof property !== "string") {
        return Reflect.get(target, property, receiver);
      }
      const existing = Reflect.get(target, property, receiver);
      if (existing !== undefined) {
        return existing;
      }
      return resolveFactoryValue(property);
    },
  });
}
