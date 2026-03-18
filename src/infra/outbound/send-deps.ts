type LegacyOutboundSendDeps = {
  sendWhatsApp?: unknown;
  sendTelegram?: unknown;
  sendDiscord?: unknown;
  sendSlack?: unknown;
  sendSignal?: unknown;
  sendIMessage?: unknown;
  sendMatrix?: unknown;
  sendMSTeams?: unknown;
};

/**
 * Dynamic bag of per-channel send functions, keyed by channel ID.
 * Keep legacy aliases here for older plugin/runtime imports.
 */
export type OutboundSendDeps = LegacyOutboundSendDeps & { [channelId: string]: unknown };

const LEGACY_SEND_DEP_KEYS = {
  whatsapp: "sendWhatsApp",
  telegram: "sendTelegram",
  discord: "sendDiscord",
  slack: "sendSlack",
  signal: "sendSignal",
  imessage: "sendIMessage",
  matrix: "sendMatrix",
  msteams: "sendMSTeams",
} as const satisfies Record<string, keyof LegacyOutboundSendDeps>;

export function resolveOutboundSendDep<T>(
  deps: OutboundSendDeps | null | undefined,
  channelId: keyof typeof LEGACY_SEND_DEP_KEYS,
): T | undefined {
  const dynamic = deps?.[channelId];
  if (dynamic !== undefined) {
    return dynamic as T;
  }
  const legacyKey = LEGACY_SEND_DEP_KEYS[channelId];
  const legacy = deps?.[legacyKey];
  return legacy as T | undefined;
}
