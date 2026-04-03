import type { OpenClawConfig, TtsConfig } from "../config/types.js";
import { canonicalizeSpeechProviderId } from "./provider-registry.js";
const RESERVED_TTS_CONFIG_KEYS = new Set([
  "auto",
  "enabled",
  "mode",
  "provider",
  "summaryModel",
  "modelOverrides",
  "providers",
  "prefsPath",
  "maxTextLength",
  "timeoutMs",
]);

const STATIC_TTS_PROVIDER_ALIASES = new Map([["edge", "microsoft"]]);

function asProviderConfig(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeProviderId(providerId: string, cfg?: OpenClawConfig): string {
  const normalized = providerId.trim().toLowerCase();
  if (cfg) {
    return canonicalizeSpeechProviderId(normalized, cfg) ?? normalized;
  }
  return STATIC_TTS_PROVIDER_ALIASES.get(normalized) ?? normalized;
}

function collectLegacyProviderKeys(raw: TtsConfig): string[] {
  const entries = raw as Record<string, unknown>;
  return Object.keys(entries)
    .filter((key) => !RESERVED_TTS_CONFIG_KEYS.has(key))
    .filter((key) => {
      const value = entries[key];
      return typeof value === "object" && value !== null && !Array.isArray(value);
    });
}

function collectLegacyProviderIds(raw: TtsConfig, cfg?: OpenClawConfig): string[] {
  return [
    ...new Set(
      collectLegacyProviderKeys(raw).map((providerId) => normalizeProviderId(providerId, cfg)),
    ),
  ];
}

function collectProviderConfigs(
  raw: TtsConfig,
  cfg?: OpenClawConfig,
): Record<string, Record<string, unknown>> {
  const entries = raw as Record<string, unknown>;
  const merged: Record<string, Record<string, unknown>> = {};

  for (const providerKey of collectLegacyProviderKeys(raw)) {
    const providerId = normalizeProviderId(providerKey, cfg);
    merged[providerId] = {
      ...merged[providerId],
      ...asProviderConfig(entries[providerKey]),
    };
  }

  for (const [providerKey, value] of Object.entries(raw.providers ?? {})) {
    const providerId = normalizeProviderId(providerKey, cfg);
    merged[providerId] = {
      ...merged[providerId],
      ...asProviderConfig(value),
    };
  }

  return merged;
}

export function mergeTtsConfig(
  base: TtsConfig,
  override?: TtsConfig,
  cfg?: OpenClawConfig,
): TtsConfig {
  if (!override) {
    return base;
  }

  const mergedEntries = { ...base, ...override } as Record<string, unknown>;
  const baseProviders = collectProviderConfigs(base, cfg);
  const overrideProviders = collectProviderConfigs(override, cfg);
  const mergedProviders = Object.fromEntries(
    [...new Set([...Object.keys(baseProviders), ...Object.keys(overrideProviders)])].map(
      (providerId) => [
        providerId,
        {
          ...baseProviders[providerId],
          ...overrideProviders[providerId],
        },
      ],
    ),
  );
  const legacyProviderIds = [
    ...new Set([
      ...collectLegacyProviderIds(base, cfg),
      ...collectLegacyProviderIds(override, cfg),
    ]),
  ];
  const legacyProviderKeys = [
    ...new Set([...collectLegacyProviderKeys(base), ...collectLegacyProviderKeys(override)]),
  ];
  const mergedLegacyProviders = Object.fromEntries(
    legacyProviderIds.map((providerId) => [providerId, mergedProviders[providerId] ?? {}]),
  );

  for (const providerKey of legacyProviderKeys) {
    delete mergedEntries[providerKey];
  }
  for (const providerId of legacyProviderIds) {
    delete mergedEntries[providerId];
  }

  return {
    ...mergedEntries,
    ...mergedLegacyProviders,
    modelOverrides: {
      ...base.modelOverrides,
      ...override.modelOverrides,
    },
    ...(Object.keys(mergedProviders).length === 0 ? {} : { providers: mergedProviders }),
  };
}
