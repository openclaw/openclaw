// Maps CLI send dependency sources into outbound send dependencies with legacy aliases.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  resolveLegacyOutboundSendDepKeys,
  type OutboundSendDeps,
} from "../infra/outbound/send-deps.js";

export type CliOutboundSendSource = {
  [channelId: string]: unknown;
};

function resolveChannelIdFromLegacySourceKey(key: string): string | undefined {
  const match = key.match(/^sendMessage(.+)$/);
  if (!match) {
    return undefined;
  }
  const normalizedStem = normalizeLowercaseStringOrEmpty(match[1]).replace(/[-_]/g, "");
  return normalizedStem || undefined;
}

/** Preserve explicit dependencies while filling channel and legacy aliases. */
export function createOutboundSendDepsFromCliSource(deps: CliOutboundSendSource): OutboundSendDeps {
  const outbound: OutboundSendDeps = { ...deps };

  for (const legacySourceKey of Object.keys(deps)) {
    const channelId = resolveChannelIdFromLegacySourceKey(legacySourceKey);
    if (!channelId) {
      continue;
    }
    const sourceValue = deps[legacySourceKey];
    if (sourceValue !== undefined && outbound[channelId] === undefined) {
      outbound[channelId] = sourceValue;
    }
  }

  for (const channelId of Object.keys(outbound)) {
    const sourceValue = outbound[channelId];
    if (sourceValue === undefined) {
      continue;
    }
    for (const legacyDepKey of resolveLegacyOutboundSendDepKeys(channelId)) {
      if (outbound[legacyDepKey] === undefined) {
        outbound[legacyDepKey] = sourceValue;
      }
    }
  }

  return outbound;
}
