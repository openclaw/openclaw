/**
 * Channel legacy config rule collector.
 *
 * Gathers channel-owned doctor migration rules from public artifacts and plugin hooks.
 */
import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../config/types.js";
import { listPluginDoctorLegacyConfigRules } from "../../plugins/doctor-contract-registry.js";
import { getBootstrapChannelPlugin } from "./bootstrap-registry.js";
import { loadBundledChannelDoctorContractApi } from "./doctor-contract-api.js";
import type { ChannelId } from "./types.public.js";

function collectConfiguredChannelIds(raw: unknown): ChannelId[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const channels = (raw as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return [];
  }
  return Object.keys(channels)
    .filter((channelId) => channelId !== "defaults")
    .map((channelId) => channelId as ChannelId);
}

function shouldIncludeLegacyRuleForTouchedPaths(
  rulePath: readonly string[],
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
): boolean {
  if (!touchedPaths || touchedPaths.length === 0) {
    return true;
  }
  // A rule is relevant when either side is a prefix of the other. This lets a
  // changed parent path include child rules without scanning all config rules.
  return touchedPaths.some((touchedPath) => {
    const sharedLength = Math.min(rulePath.length, touchedPath.length);
    for (let index = 0; index < sharedLength; index += 1) {
      if (rulePath[index] !== touchedPath[index]) {
        return false;
      }
    }
    return true;
  });
}

function readLegacyConfigRule(rule: unknown): LegacyConfigRule | undefined {
  if (!rule || typeof rule !== "object") {
    return undefined;
  }
  let path: unknown;
  let message: unknown;
  let match: unknown;
  let requireSourceLiteral: unknown;
  try {
    const candidate = rule as LegacyConfigRule;
    path = candidate.path;
    message = candidate.message;
    match = candidate.match;
    requireSourceLiteral = candidate.requireSourceLiteral;
  } catch {
    return undefined;
  }
  if (!Array.isArray(path) || !path.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  if (typeof message !== "string") {
    return undefined;
  }
  const safeRule: LegacyConfigRule = {
    path: [...path],
    message,
  };
  if (typeof match === "function") {
    safeRule.match = (value, root) => {
      try {
        return match(value, root) === true;
      } catch {
        return false;
      }
    };
  }
  if (requireSourceLiteral === true) {
    safeRule.requireSourceLiteral = true;
  }
  return safeRule;
}

function collectReadableLegacyConfigRules(rules: unknown): LegacyConfigRule[] {
  if (!Array.isArray(rules)) {
    return [];
  }
  const readableRules: LegacyConfigRule[] = [];
  let ruleCount: number;
  try {
    ruleCount = rules.length;
  } catch {
    return readableRules;
  }
  for (let index = 0; index < ruleCount; index += 1) {
    let rule: unknown;
    try {
      rule = rules[index];
    } catch {
      continue;
    }
    const readableRule = readLegacyConfigRule(rule);
    if (readableRule) {
      readableRules.push(readableRule);
    }
  }
  return readableRules;
}

function readBootstrapLegacyConfigRules(channelId: ChannelId): {
  pluginFound: boolean;
  rules: LegacyConfigRule[];
} {
  const plugin = getBootstrapChannelPlugin(channelId);
  if (!plugin) {
    return { pluginFound: false, rules: [] };
  }
  let rules: unknown;
  try {
    rules = plugin.doctor?.legacyConfigRules;
  } catch {
    return { pluginFound: true, rules: [] };
  }
  return {
    pluginFound: true,
    rules: collectReadableLegacyConfigRules(rules),
  };
}

function readBundledLegacyConfigRules(
  contractApi: ReturnType<typeof loadBundledChannelDoctorContractApi>,
): {
  contractFound: boolean;
  rules: LegacyConfigRule[];
} {
  if (!contractApi) {
    return { contractFound: false, rules: [] };
  }
  let rules: unknown;
  try {
    rules = contractApi.legacyConfigRules;
  } catch {
    return { contractFound: true, rules: [] };
  }
  if (!Array.isArray(rules)) {
    return { contractFound: false, rules: [] };
  }
  return {
    contractFound: true,
    rules: collectReadableLegacyConfigRules(rules),
  };
}

function collectRelevantChannelIdsForTouchedPaths(params: {
  raw?: unknown;
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>;
  excludedChannelIds?: ReadonlySet<ChannelId>;
}): ChannelId[] {
  const channelIds = collectConfiguredChannelIds(params.raw);
  const filteredChannelIds = params.excludedChannelIds?.size
    ? channelIds.filter((channelId) => !params.excludedChannelIds?.has(channelId))
    : channelIds;
  if (!params.touchedPaths || params.touchedPaths.length === 0) {
    return filteredChannelIds;
  }

  const touchedChannelIds = new Set<ChannelId>();
  for (const touchedPath of params.touchedPaths) {
    const [first, second] = touchedPath;
    if (first !== "channels") {
      continue;
    }
    if (!second) {
      return filteredChannelIds;
    }
    if (second === "defaults") {
      continue;
    }
    // Channel ids are the second segment under channels.*; deeper touched paths
    // still map back to the owning channel for rule collection.
    touchedChannelIds.add(second as ChannelId);
  }

  if (touchedChannelIds.size === 0) {
    return [];
  }
  return filteredChannelIds.filter((channelId) => touchedChannelIds.has(channelId));
}

export function collectChannelLegacyConfigRules(
  raw?: unknown,
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
  excludedChannelIds?: ReadonlySet<ChannelId>,
): LegacyConfigRule[] {
  const channelIds = collectRelevantChannelIdsForTouchedPaths({
    raw,
    touchedPaths,
    excludedChannelIds,
  });
  const rules: LegacyConfigRule[] = [];
  const unresolvedChannelIds: ChannelId[] = [];
  for (const channelId of channelIds) {
    const bundled = readBundledLegacyConfigRules(loadBundledChannelDoctorContractApi(channelId));
    if (bundled.contractFound) {
      rules.push(...bundled.rules);
      continue;
    }

    const bootstrap = readBootstrapLegacyConfigRules(channelId);
    if (bootstrap.rules.length > 0) {
      rules.push(...bootstrap.rules);
      continue;
    }
    if (bootstrap.pluginFound) {
      continue;
    }

    // Unknown configured channels may be externally installed plugins. Ask the
    // plugin doctor registry only after bundled/bootstrap lookups miss.
    unresolvedChannelIds.push(channelId);
  }
  if (unresolvedChannelIds.length > 0) {
    rules.push(
      ...collectReadableLegacyConfigRules(
        listPluginDoctorLegacyConfigRules({
          config: raw as OpenClawConfig,
          pluginIds: unresolvedChannelIds,
        }),
      ),
    );
  }

  const seen = new Set<string>();
  return rules.filter((rule) => {
    if (!shouldIncludeLegacyRuleForTouchedPaths(rule.path, touchedPaths)) {
      return false;
    }
    const key = `${rule.path.join(".")}::${rule.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
