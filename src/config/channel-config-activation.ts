import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Returns a channel config object when `channels.<id>` is present and object-shaped. */
export function resolveChannelConfigRecord(
  cfg: OpenClawConfig,
  channelId: string,
): Record<string, unknown> | null {
  const entry = cfg.channels?.[channelId];
  return isRecord(entry) ? entry : null;
}

/** Returns true when channel settings supply activation intent beyond enabled/disabled state. */
export function hasMeaningfulChannelConfig(value: unknown, channelId?: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  // Teams can use env-only auth; preserving its transport must not opt it into activation.
  return Object.keys(value).some(
    (key) => key !== "enabled" && (channelId !== "msteams" || key !== "legacyWebhook"),
  );
}

/** Checks whether a shallow channel config contains activation-relevant values. */
export function hasMeaningfulChannelConfigShallow(value: unknown, channelId?: string): boolean {
  return (
    (isRecord(value) && value.enabled === true) || hasMeaningfulChannelConfig(value, channelId)
  );
}

/** Channel configuration can admit bundled plugin capabilities through an allowlist. */
export function resolveChannelConfigActivationFacts(config: OpenClawConfig): string[] {
  return Object.keys(config.channels ?? {})
    .filter((channelId) => {
      const channel = resolveChannelConfigRecord(config, channelId);
      return channel?.enabled !== false && hasMeaningfulChannelConfigShallow(channel, channelId);
    })
    .toSorted();
}
