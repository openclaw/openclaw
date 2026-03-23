import type { OutboundSendDeps } from "../infra/outbound/deliver.js";

/**
 * CLI-internal send function sources, keyed by channel ID.
 * Each value is a lazily-loaded send function for that channel.
 */
export type CliOutboundSendSource = { [channelId: string]: unknown };

const LEGACY_SOURCE_TO_CHANNEL = {
  sendMessageWhatsApp: "whatsapp",
  sendMessageTelegram: "telegram",
  sendMessageDiscord: "discord",
  sendMessageSlack: "slack",
  sendMessageSignal: "signal",
  sendMessageIMessage: "imessage",
} as const;

const CHANNEL_TO_LEGACY_DEP_KEY = {
  whatsapp: "sendWhatsApp",
  telegram: "sendTelegram",
  discord: "sendDiscord",
  slack: "sendSlack",
  signal: "sendSignal",
  imessage: "sendIMessage",
} as const;

/**
 * Pass CLI send sources through as-is — both CliOutboundSendSource and
 * OutboundSendDeps are now channel-ID-keyed records.
 */
export function createOutboundSendDepsFromCliSource(deps: CliOutboundSendSource): OutboundSendDeps {
  const outbound: OutboundSendDeps = { ...deps };

  for (const [legacySourceKey, channelId] of Object.entries(LEGACY_SOURCE_TO_CHANNEL)) {
    const sourceValue = deps[legacySourceKey];
    if (sourceValue !== undefined && outbound[channelId] === undefined) {
      outbound[channelId] = sourceValue;
    }
  }

  for (const [channelId, legacyDepKey] of Object.entries(CHANNEL_TO_LEGACY_DEP_KEY)) {
    const sourceValue = outbound[channelId];
    if (sourceValue !== undefined && outbound[legacyDepKey] === undefined) {
      outbound[legacyDepKey] = sourceValue;
    }
  }

  return outbound;
}
