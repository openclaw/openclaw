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
import { evaluateDmPolicyAllowFromDependency } from "./zod-schema.core.js";

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
 * Warn about DM policy/allowlist dependencies without rejecting otherwise usable
 * configs. Shared readers resolve account inheritance; paths follow canonical fields.
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
    const nested = mode === "nestedOnly";
    const policyKey = nested ? "dm.policy" : "dmPolicy";
    const allowFromKey = nested ? "dm.allowFrom" : "allowFrom";
    const appendWarning = (account: Record<string, unknown>, accountId?: string) => {
      const parent = accountId === undefined ? undefined : channelValue;
      const accountDm = isRecord(account.dm) ? account.dm : undefined;
      const parentDm = parent && isRecord(parent.dm) ? parent.dm : undefined;
      if (nested && (accountDm?.enabled ?? parentDm?.enabled) === false) {
        return;
      }
      // Doctor reads legacy aliases for migration, but nested-only runtimes ignore
      // them. Project canonical fields so aliases cannot conceal a runtime denial.
      const access = {
        account: nested ? { dm: accountDm } : account,
        parent: nested ? { dm: parentDm } : parent,
        mode,
      };
      const violation = evaluateDmPolicyAllowFromDependency({
        policy: resolveChannelDmPolicy(access),
        allowFrom: resolveChannelDmAllowFrom(access),
      });
      if (
        violation &&
        (violation !== "open_requires_wildcard" || openDmRequiresAllowFromWildcard)
      ) {
        const channelBase = `channels.${channelId}`;
        const scope = accountId ? `${channelBase}.accounts.${accountId}` : channelBase;
        const allowFromPath = `${scope}.${allowFromKey}`;
        const channelAllowFromPath = `${channelBase}.${allowFromKey}`;
        const policyPath = `${scope}.${policyKey}`;
        const inherited = Boolean(accountId) && !hasConfiguredDmAllowFrom(access.account);
        const allowFromSubject = inherited
          ? `${allowFromPath} is unset and ${channelAllowFromPath}`
          : allowFromPath;
        const accountInheritedTarget = inherited ? ` or ${channelAllowFromPath}` : "";
        const accountOverrideFix =
          accountId && !inherited
            ? `, remove ${allowFromPath} to inherit ${channelAllowFromPath},`
            : "";
        const message =
          violation === "open_requires_wildcard"
            ? `${policyPath}="open" but ${allowFromSubject} does not include "*"; DMs from unlisted senders will be dropped. Add "*" to ${allowFromPath}${accountInheritedTarget}${accountOverrideFix} or set ${policyPath} to "pairing"/"allowlist".`
            : `${policyPath}="allowlist" but ${allowFromSubject} is empty; all DMs will be dropped. Add at least one sender ID to ${allowFromPath}${accountInheritedTarget}${accountOverrideFix} or change ${policyPath}.`;
        warnings.push({ path: allowFromPath, message });
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
