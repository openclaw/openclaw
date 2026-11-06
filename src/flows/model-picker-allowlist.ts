// Applies configure model selections to an existing model allowlist.
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH,
  resolveConfiguredModelPolicyAllow,
} from "../agents/model-selection-shared.js";
import {
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import { parseModelPolicyWildcardRef } from "../config/model-policy-ref.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { t } from "../wizard/i18n/index.js";

export function normalizeModelKeys(values: string[]): string[] {
  return [...new Set(Array.from(values, normalizeAgentModelRefForConfig).filter(Boolean))];
}

/**
 * Initial picker selections. Re-running configure starts from the saved allowlist,
 * including wildcard matches, so earlier picks stay selected; fallback-only
 * selection starts from the primary and its fallbacks.
 */
export function createPickerSeeds(params: {
  config: OpenClawConfig;
  agentId?: string;
  restrictsPicker?: boolean;
  initialSeeds: string[];
  primary: string;
  fallbacks: string[];
}): {
  scoped: (scope: string[]) => string[];
  text: (configuredKeys: string[]) => { message: string; initialValue: string };
} {
  const policy =
    params.restrictsPicker === false
      ? undefined
      : createModelVisibilityPolicy({
          cfg: params.config,
          catalog: [],
          defaultProvider: DEFAULT_PROVIDER,
          agentId: params.agentId,
        });
  const allowedBySavedPolicy = (key: string) => {
    const slash = key.indexOf("/");
    const ref = { provider: key.slice(0, slash), model: key.slice(slash + 1) };
    // `allows` needs catalog rows for exact refs; the policy's own key set does not.
    return Boolean(
      policy &&
      !policy.allowAny &&
      slash > 0 &&
      (policy.allowedKeys.has(key) || policy.allowsByWildcard(ref)),
    );
  };
  const fallbackOnly = params.restrictsPicker === false;
  const savedRefs = resolveConfiguredModelPolicyAllow({
    cfg: params.config,
    agentId: params.agentId,
  }).refs;
  return {
    scoped: (scope) =>
      normalizeModelKeys([
        ...(fallbackOnly ? [params.primary, ...params.fallbacks] : params.initialSeeds),
        ...scope.filter(allowedBySavedPolicy),
      ]).filter((key) => scope.includes(key)),
    // Without a catalog the text prompt edits the saved list itself, wildcards included.
    text: (configuredKeys) => {
      const unrestricted =
        configuredKeys.length > 0
          ? normalizeModelKeys([...configuredKeys, ...params.fallbacks])
          : [];
      const keys = fallbackOnly
        ? params.fallbacks
        : savedRefs.length > 0
          ? [...savedRefs]
          : unrestricted;
      return {
        message: t(fallbackOnly ? "wizard.model.fallbackText" : "wizard.model.allowlistText"),
        initialValue: keys.join(", "),
      };
    },
  };
}

/**
 * Applies a configure-picker selection to the default model allowlist.
 * Configure never creates an allowlist: without one, models of providers with
 * auth already show. With one, the scoped provider's refs are replaced by the
 * selection as exact refs. An existing `<provider>/*` stays when every offered model
 * of that provider stays selected; configure never adds a wildcard on its own.
 */
export function applyModelAllowlist(
  cfg: OpenClawConfig,
  models: string[],
  opts: { scopeKeys?: string[] } = {},
): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  const policy = resolveConfiguredModelPolicyAllow({ cfg });
  if (policy.refs.length === 0) {
    return cfg;
  }
  const normalized = normalizeModelKeys(models);
  const scopeKeys = opts.scopeKeys ? normalizeModelKeys(opts.scopeKeys) : [];
  const scopeKeySet = scopeKeys.length > 0 ? new Set(scopeKeys) : null;
  const existingAllow = normalizeModelKeys([...policy.refs]);
  const providerOf = (key: string) => normalizeProviderId(key.slice(0, key.indexOf("/")));
  const scopeProviders = new Set(scopeKeys.map(providerOf));
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: DEFAULT_PROVIDER });
  const isPolicyRefInScope = (raw: string): boolean => {
    const wildcard = parseModelPolicyWildcardRef(raw);
    if (wildcard) {
      return scopeProviders.has(wildcard.provider);
    }
    const resolved = resolveModelRefFromString({
      cfg,
      raw: raw.trim(),
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    return Boolean(
      resolved && scopeKeySet?.has(modelKey(resolved.ref.provider, resolved.ref.model)),
    );
  };
  let nextAllow: string[];
  if (!scopeKeySet) {
    nextAllow = normalized;
  } else {
    const selected = new Set(normalized);
    nextAllow = existingAllow.filter((key) => !isPolicyRefInScope(key));
    for (const provider of scopeProviders) {
      const providerScope = scopeKeys.filter((key) => providerOf(key) === provider);
      const picks = providerScope.filter((key) => selected.has(key));
      const keepsWildcard =
        picks.length === providerScope.length &&
        existingAllow.some((ref) => parseModelPolicyWildcardRef(ref)?.key === `${provider}/*`);
      const refs = keepsWildcard ? [`${provider}/*`] : picks;
      for (const ref of refs) {
        if (!nextAllow.includes(ref)) {
          nextAllow.push(ref);
        }
      }
    }
  }
  if (nextAllow.length === 0 && policy.configPath !== LEGACY_MODEL_POLICY_ALLOW_CONFIG_PATH) {
    // An empty allowlist is no restriction. A legacy map instead needs the explicit
    // empty policy, or the map would keep restricting.
    const { modelPolicy: _removed, ...rest } = defaults ?? {};
    return { ...cfg, agents: { ...cfg.agents, defaults: rest } };
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: { ...defaults, modelPolicy: { ...defaults?.modelPolicy, allow: nextAllow } },
    },
  };
}
