import type { TtsConfig } from "../config/types.js";
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

function asProviderConfig(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeProviderId(providerId: string): string {
  return canonicalizeSpeechProviderId(providerId) ?? providerId.trim().toLowerCase();
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

function collectLegacyProviderIds(raw: TtsConfig): string[] {
  return [...new Set(collectLegacyProviderKeys(raw).map(normalizeProviderId))];
}

function collectProviderConfigs(raw: TtsConfig): Record<string, Record<string, unknown>> {
  const entries = raw as Record<string, unknown>;
  const merged: Record<string, Record<string, unknown>> = {};

  for (const providerKey of collectLegacyProviderKeys(raw)) {
    const providerId = normalizeProviderId(providerKey);
    merged[providerId] = {
      ...merged[providerId],
      ...asProviderConfig(entries[providerKey]),
    };
  }

  for (const [providerKey, value] of Object.entries(raw.providers ?? {})) {
    const providerId = normalizeProviderId(providerKey);
    merged[providerId] = {
      ...merged[providerId],
      ...asProviderConfig(value),
    };
  }

  return merged;
}

export function mergeTtsConfig(base: TtsConfig, override?: TtsConfig): TtsConfig {
  if (!override) {
    return base;
  }

  const mergedEntries = { ...base, ...override } as Record<string, unknown>;
  const baseProviders = collectProviderConfigs(base);
  const overrideProviders = collectProviderConfigs(override);
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
    ...new Set([...collectLegacyProviderIds(base), ...collectLegacyProviderIds(override)]),
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
