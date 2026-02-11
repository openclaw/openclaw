/**
 * Heimdall Config Resolver — merge global + per-channel overrides.
 *
 * Merge semantics:
 * - senderTiers.owners / members: UNION (deduped)
 * - toolACL: per-channel REPLACES global
 * - outputFilter.customPatterns: UNION (deduped by name, channel wins)
 * - outputFilter.enabled: per-channel overrides global
 * - sanitize, rateLimit, audit: shallow merge (per-channel fields override)
 * - enabled: if globally disabled, per-channel cannot re-enable
 */

import type { HeimdallConfig, OutputFilterPattern } from "./types.js";

export function resolveHeimdallConfig(
  global?: HeimdallConfig,
  channel?: HeimdallConfig,
): HeimdallConfig | undefined {
  if (!global && !channel) {
    return undefined;
  }
  if (!channel) {
    return global;
  }
  if (!global) {
    return channel;
  }

  // enabled: globally disabled → stays disabled
  const enabled = global.enabled === false ? false : (channel.enabled ?? global.enabled);

  // senderTiers: UNION
  const globalOwners = global.senderTiers?.owners ?? [];
  const channelOwners = channel.senderTiers?.owners ?? [];
  const globalMembers = global.senderTiers?.members ?? [];
  const channelMembers = channel.senderTiers?.members ?? [];
  const owners = dedup([...globalOwners, ...channelOwners]);
  const members = dedup([...globalMembers, ...channelMembers]);

  // toolACL: per-channel replaces
  const toolACL = channel.toolACL ?? global.toolACL;

  // defaultGuestPolicy: per-channel overrides
  const defaultGuestPolicy = channel.defaultGuestPolicy ?? global.defaultGuestPolicy;

  // outputFilter: merge
  const outputFilter = mergeOutputFilter(global.outputFilter, channel.outputFilter);

  // sanitize: shallow merge
  const sanitize =
    global.sanitize || channel.sanitize ? { ...global.sanitize, ...channel.sanitize } : undefined;

  // rateLimit: shallow merge
  const rateLimit =
    global.rateLimit || channel.rateLimit
      ? { ...global.rateLimit, ...channel.rateLimit }
      : undefined;

  // audit: shallow merge
  const audit = global.audit || channel.audit ? { ...global.audit, ...channel.audit } : undefined;

  return {
    enabled,
    senderTiers:
      owners.length > 0 || members.length > 0
        ? {
            ...(owners.length > 0 ? { owners } : {}),
            ...(members.length > 0 ? { members } : {}),
          }
        : global.senderTiers,
    defaultGuestPolicy,
    toolACL,
    outputFilter,
    sanitize,
    rateLimit,
    audit,
  };
}

function dedup(arr: Array<string | number>): Array<string | number> {
  const seen = new Set<string | number>();
  const result: Array<string | number> = [];
  for (const item of arr) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function mergeOutputFilter(
  global?: HeimdallConfig["outputFilter"],
  channel?: HeimdallConfig["outputFilter"],
): HeimdallConfig["outputFilter"] {
  if (!global && !channel) {
    return undefined;
  }
  if (!channel) {
    return global;
  }
  if (!global) {
    return channel;
  }

  const enabled = channel.enabled ?? global.enabled;

  // customPatterns: UNION deduped by name, channel wins on conflict
  const globalPatterns = global.customPatterns ?? [];
  const channelPatterns = channel.customPatterns ?? [];
  const merged = mergePatternsByName(globalPatterns, channelPatterns);

  return {
    enabled,
    ...(merged.length > 0 ? { customPatterns: merged } : {}),
  };
}

function mergePatternsByName(
  global: OutputFilterPattern[],
  channel: OutputFilterPattern[],
): OutputFilterPattern[] {
  const byName = new Map<string, OutputFilterPattern>();
  for (const p of global) {
    byName.set(p.name, p);
  }
  for (const p of channel) {
    byName.set(p.name, p);
  } // channel overwrites
  return [...byName.values()];
}
