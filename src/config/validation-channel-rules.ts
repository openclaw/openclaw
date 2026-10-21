import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  type ChannelDmAllowFromMode,
  resolveChannelDmAllowFrom,
  resolveChannelDmPolicy,
} from "../channels/plugins/dm-access.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { isRecord } from "../utils.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import type { ChannelDmPolicyMetadata } from "./channel-config-metadata.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";
import {
  type DmPolicyAllowFromViolation,
  evaluateDmPolicyAllowFromDependency,
} from "./zod-schema.core.js";

const bundledChannelSchemaById = new Map<string, unknown>(
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter((entry) => entry.configurable !== false).map(
    (entry) => [entry.channelId, entry.schema] as const,
  ),
);

export const bundledChannelIds = Object.freeze(
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter((entry) => entry.configurable !== false)
    .map((entry) => normalizeLowercaseStringOrEmpty(entry.channelId))
    .filter((channelId) => channelId.length > 0),
);

function buildDmPolicyDependencyWarning(params: {
  channelId: string;
  accountId?: string;
  allowFromSource?: "explicit" | "inherited";
  violation: DmPolicyAllowFromViolation;
}): ConfigValidationIssue {
  const channelBase = `channels.${params.channelId}`;
  const scope = params.accountId ? `${channelBase}.accounts.${params.accountId}` : channelBase;
  const allowFromPath = `${scope}.allowFrom`;
  const inherited = params.accountId && params.allowFromSource === "inherited";
  const allowFromSubject = inherited
    ? `${allowFromPath} is unset and ${channelBase}.allowFrom`
    : allowFromPath;
  const accountInheritedTarget = inherited ? ` or ${channelBase}.allowFrom` : "";
  const accountOverrideFix =
    params.accountId && !inherited
      ? `, remove ${allowFromPath} to inherit ${channelBase}.allowFrom,`
      : "";
  const message =
    params.violation === "open_requires_wildcard"
      ? `${scope}.dmPolicy="open" but ${allowFromSubject} does not include "*"; all DMs will be dropped. Add "*" to ${allowFromPath}${accountInheritedTarget}${accountOverrideFix} or set ${scope}.dmPolicy to "pairing"/"allowlist".`
      : `${scope}.dmPolicy="allowlist" but ${allowFromSubject} is empty; all DMs will be dropped. Add at least one sender ID to ${allowFromPath}${accountInheritedTarget}${accountOverrideFix} or change ${scope}.dmPolicy.`;
  return { path: allowFromPath, message };
}

// Channel map keys that are not channels and must be skipped while scanning DM policy.
const DM_POLICY_PSEUDO_CHANNEL_KEYS = new Set(["defaults", "modelByChannel", "tools"]);

function hasDefinedConfigValue(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

function hasConfiguredDmAllowFrom(record: Record<string, unknown>): boolean {
  const dm = isRecord(record.dm) ? record.dm : null;
  return (
    hasDefinedConfigValue(record, "allowFrom") ||
    (dm !== null && hasDefinedConfigValue(dm, "allowFrom"))
  );
}

export function hasChannelDmPolicyDependencyWarningCandidates(config: OpenClawConfig): boolean {
  if (!config.channels || !isRecord(config.channels)) {
    return false;
  }
  return Object.entries(config.channels).some(
    ([channelId, channelValue]) =>
      !DM_POLICY_PSEUDO_CHANNEL_KEYS.has(channelId) &&
      isRecord(channelValue) &&
      channelValue.enabled !== false,
  );
}

/**
 * Surface dmPolicy/allowFrom dependency problems generically for every channel that
 * exposes DM policy via the canonical top-level `dmPolicy`/`allowFrom` fields. These
 * configs parse fine but drop every DM at runtime, so we warn (rather than reject) to
 * stay consistent with `security audit`/`doctor` and avoid breaking existing-but-usable
 * configs on upgrade.
 *
 * Resolution goes through the shared DM-access helpers so the warning matches the
 * effective policy/allowFrom the runtime sees, including the legacy `dm.*` aliases and
 * account->channel inheritance. `nestedOnly` channels (canonical fields under `dm.*`)
 * are skipped because their config shape does not match this warning's top-level paths.
 */
export function collectChannelDmPolicyDependencyWarnings(
  config: OpenClawConfig,
  options: {
    dmPolicyMetadata?: ReadonlyMap<string, ChannelDmPolicyMetadata>;
  } = {},
): ConfigValidationIssue[] {
  if (!config.channels || !isRecord(config.channels)) {
    return [];
  }
  const warnings: ConfigValidationIssue[] = [];
  for (const [channelId, channelValue] of Object.entries(config.channels)) {
    if (
      DM_POLICY_PSEUDO_CHANNEL_KEYS.has(channelId) ||
      !isRecord(channelValue) ||
      channelValue.enabled === false
    ) {
      continue;
    }
    const metadata = options.dmPolicyMetadata?.get(channelId);
    const mode: ChannelDmAllowFromMode = metadata?.dmAllowFromMode ?? "topOnly";
    const openDmRequiresAllowFromWildcard = metadata?.openDmRequiresAllowFromWildcard !== false;
    if (mode === "nestedOnly") {
      continue;
    }
    const appendWarning = (account: Record<string, unknown>, accountId?: string) => {
      const parent = accountId === undefined ? undefined : channelValue;
      const access = { account, parent, mode };
      const violation = evaluateDmPolicyAllowFromDependency({
        policy: resolveChannelDmPolicy(access),
        allowFrom: resolveChannelDmAllowFrom(access),
      });
      if (
        violation &&
        (violation !== "open_requires_wildcard" || openDmRequiresAllowFromWildcard)
      ) {
        warnings.push(
          buildDmPolicyDependencyWarning({
            channelId,
            accountId,
            allowFromSource:
              accountId === undefined
                ? undefined
                : hasConfiguredDmAllowFrom(account)
                  ? "explicit"
                  : "inherited",
            violation,
          }),
        );
      }
    };
    appendWarning(channelValue);
    if (!isRecord(channelValue.accounts)) {
      continue;
    }
    for (const [accountId, accountValue] of Object.entries(channelValue.accounts)) {
      if (!isRecord(accountValue) || accountValue.enabled === false) {
        continue;
      }
      appendWarning(accountValue, accountId);
    }
  }
  return warnings;
}

export function collectRawBundledChannelConfigIssues(
  config: OpenClawConfig,
): ConfigValidationIssue[] {
  if (!config.channels || !isRecord(config.channels)) {
    return [];
  }
  const issues: ConfigValidationIssue[] = [];
  for (const [channelId, schema] of bundledChannelSchemaById) {
    if (!Object.hasOwn(config.channels, channelId)) {
      continue;
    }
    const result = validateJsonSchemaValue({
      schema: schema as Record<string, unknown>,
      cacheKey: `raw-channel:${channelId}`,
      value: config.channels[channelId],
      applyDefaults: false,
    });
    if (result.ok) {
      continue;
    }
    for (const error of result.errors) {
      const message = error.additionalProperty
        ? `${error.message}: "${error.additionalProperty}"`
        : error.message;
      const path =
        error.path === "<root>" ? `channels.${channelId}` : `channels.${channelId}.${error.path}`;
      issues.push({
        path,
        message: `invalid config: ${message}`,
        allowedValues: error.allowedValues,
        allowedValuesHiddenCount: error.allowedValuesHiddenCount,
      });
    }
  }
  return issues;
}
