/** Protects active auth profile metadata while doctor repairs broader config state. */
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import {
  normalizeLowercaseStringOrEmpty as normalizeProviderId,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import type { AuthProfileConfig } from "../config/types.auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";

function normalizeMode(value: unknown): AuthProfileConfig["mode"] | null {
  return value === "api_key" || value === "aws-sdk" || value === "oauth" || value === "token"
    ? value
    : null;
}

function extractProviderPrefix(value: string, separator: ":" | "/"): string | null {
  const index = value.indexOf(separator);
  return index > 0 ? normalizeProviderId(value.slice(0, index)) || null : null;
}

function collectActiveAuthHints(config: OpenClawConfig) {
  const activeProviders = new Set<string>();
  const explicitProfileIds = new Set<string>();
  const explicitProfileProviders = new Map<string, Set<string>>();

  const models = isRecord(config.models) ? config.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};
  for (const providerId of Object.keys(providers)) {
    const normalized = normalizeProviderId(providerId);
    if (normalized) {
      activeProviders.add(normalized);
    }
  }

  for (const { value } of collectConfiguredModelRefs(config)) {
    const { model, profile } = splitTrailingAuthProfile(value);
    const provider = extractProviderPrefix(model, "/");
    if (profile) {
      explicitProfileIds.add(profile);
      if (provider) {
        const providersLocal = explicitProfileProviders.get(profile) ?? new Set<string>();
        providersLocal.add(provider);
        explicitProfileProviders.set(profile, providersLocal);
      }
    }
    if (provider) {
      activeProviders.add(provider);
    }
  }

  const auth = isRecord(config.auth) ? config.auth : {};
  const order = isRecord(auth.order) ? auth.order : {};
  for (const [providerId, profileIds] of Object.entries(order)) {
    const provider = normalizeProviderId(providerId);
    if (!provider || !activeProviders.has(provider) || !Array.isArray(profileIds)) {
      continue;
    }
    for (const profileId of profileIds) {
      const normalized = normalizeOptionalString(profileId);
      if (normalized) {
        explicitProfileIds.add(normalized);
      }
    }
  }

  return { activeProviders, explicitProfileIds, explicitProfileProviders };
}

function isValidProfileMetadata(value: unknown): value is AuthProfileConfig {
  if (!isRecord(value)) {
    return false;
  }
  return normalizeProviderId(value.provider) !== "" && normalizeMode(value.mode) !== null;
}

export function ensureConfigAuthProfiles(
  config: OpenClawConfig,
): Record<string, AuthProfileConfig> {
  const root = config as Record<string, unknown>;
  const auth: Record<string, unknown> = isRecord(root.auth) ? root.auth : {};
  if (root.auth !== auth) {
    root.auth = auth;
  }
  if (!isRecord(auth.profiles)) {
    auth.profiles = {};
  }
  return auth.profiles as Record<string, AuthProfileConfig>;
}

/**
 * Restores valid metadata for auth profiles still referenced by active model config.
 *
 * Doctor can rebuild or prune auth config; this guard keeps active profiles usable when their
 * provider/mode metadata can be inferred from the before/after config or profile id.
 */
export function protectActiveAuthProfileConfig(params: {
  before: OpenClawConfig;
  after: OpenClawConfig;
}) {
  const { activeProviders, explicitProfileIds, explicitProfileProviders } = collectActiveAuthHints(
    params.before,
  );
  const beforeAuth = isRecord(params.before.auth) ? params.before.auth : {};
  const beforeProfiles = isRecord(beforeAuth.profiles) ? beforeAuth.profiles : {};
  if (Object.keys(beforeProfiles).length === 0) {
    return { config: params.after, repairs: [], warnings: [] };
  }

  const config = structuredClone(params.after);
  const afterAuth = isRecord(config.auth) ? config.auth : {};
  const afterProfiles = isRecord(afterAuth.profiles) ? afterAuth.profiles : {};
  const repairs: string[] = [];
  const warnings: string[] = [];

  for (const [profileId, beforeProfile] of Object.entries(beforeProfiles)) {
    const afterProfile = afterProfiles[profileId];
    const after: Record<string, unknown> = isRecord(afterProfile) ? afterProfile : {};
    const before: Record<string, unknown> = isRecord(beforeProfile) ? beforeProfile : {};
    if (isValidProfileMetadata(afterProfile)) {
      continue;
    }
    let provider =
      normalizeProviderId(after.provider) ||
      normalizeProviderId(before.provider) ||
      extractProviderPrefix(profileId, ":");
    const protectsActiveProvider = provider !== null && activeProviders.has(provider);
    const protectsExplicitProfile = explicitProfileIds.has(profileId);
    if (!protectsActiveProvider && !protectsExplicitProfile) {
      continue;
    }

    const hints = explicitProfileProviders.get(profileId);
    provider ||= normalizeProviderId(hints?.size === 1 ? [...hints][0] : undefined);
    if (!provider) {
      warnings.push(
        `auth.profiles.${profileId}: active auth profile metadata could not be inferred; repair manually before running doctor --fix.`,
      );
      continue;
    }
    const repaired: AuthProfileConfig = {
      provider,
      mode: normalizeMode(after.mode) ?? normalizeMode(before.mode) ?? "api_key",
    };
    for (const key of ["email", "displayName"] as const) {
      const value = normalizeOptionalString(after[key]) ?? normalizeOptionalString(before[key]);
      if (value) {
        repaired[key] = value;
      }
    }
    const profiles = ensureConfigAuthProfiles(config);
    profiles[profileId] = repaired;
    repairs.push(
      `Repaired auth.profiles.${profileId} metadata for active ${repaired.provider} auth.`,
    );
  }

  return { config, repairs, warnings };
}

export function stripImportedConfigAuthProfileCredentials(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
): boolean {
  const profiles = ensureConfigAuthProfiles(cfg);
  let changed = false;
  for (const [profileId, credential] of Object.entries(store.profiles)) {
    const current = profiles[profileId];
    if (!current) {
      continue;
    }
    const metadata: AuthProfileConfig = {
      provider: current.provider || credential.provider,
      mode: credential.type,
      ...(current.email ? { email: current.email } : {}),
      ...(current.displayName ? { displayName: current.displayName } : {}),
    };
    profiles[profileId] = metadata;
    changed = true;
  }
  return changed;
}
