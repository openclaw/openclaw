import {
  applyCompactionDefaults,
  applyContextPruningDefaults,
  applyAgentDefaults,
  applyLoggingDefaults,
  applyMessageDefaults,
  applyModelDefaults,
  applySessionDefaults,
  applyTalkApiKey,
  applyTalkConfigNormalization,
} from "./defaults.js";
import { normalizeExecSafeBinProfilesInConfig } from "./normalize-exec-safe-bin.js";
import { normalizeConfigPaths } from "./normalize-paths.js";
import type { OpenClawConfig, ResolvedSourceConfig, RuntimeConfig } from "./types.js";

export type ConfigMaterializationMode = "load" | "missing" | "snapshot";

type MaterializationProfile = {
  includeTalkApiKey: boolean;
  includeCompactionDefaults: boolean;
  includeContextPruningDefaults: boolean;
  includeLoggingDefaults: boolean;
  normalizePaths: boolean;
};

const MATERIALIZATION_PROFILES: Record<ConfigMaterializationMode, MaterializationProfile> = {
  load: {
    includeTalkApiKey: false,
    includeCompactionDefaults: true,
    includeContextPruningDefaults: true,
    includeLoggingDefaults: true,
    normalizePaths: true,
  },
  missing: {
    includeTalkApiKey: true,
    includeCompactionDefaults: true,
    includeContextPruningDefaults: true,
    includeLoggingDefaults: false,
    normalizePaths: false,
  },
  snapshot: {
    includeTalkApiKey: true,
    includeCompactionDefaults: false,
    includeContextPruningDefaults: false,
    includeLoggingDefaults: true,
    normalizePaths: true,
  },
};

export function asResolvedSourceConfig(config: OpenClawConfig): ResolvedSourceConfig {
  return config as ResolvedSourceConfig;
}

export function asRuntimeConfig(config: OpenClawConfig): RuntimeConfig {
  return config as RuntimeConfig;
}

export function materializeRuntimeConfig(
  config: OpenClawConfig,
  mode: ConfigMaterializationMode,
): RuntimeConfig {
  const profile = MATERIALIZATION_PROFILES[mode];
  let next = applyMessageDefaults(config);
  if (profile.includeLoggingDefaults) {
    next = applyLoggingDefaults(next);
  }
  next = applySessionDefaults(next);
  next = applyAgentDefaults(next);
  if (profile.includeContextPruningDefaults) {
    next = applyContextPruningDefaults(next);
  }
  if (profile.includeCompactionDefaults) {
    next = applyCompactionDefaults(next);
  }
  next = applyModelDefaults(next);
  next = applyTalkConfigNormalization(next);
  if (profile.includeTalkApiKey) {
    next = applyTalkApiKey(next);
  }
  if (profile.normalizePaths) {
    normalizeConfigPaths(next);
  }
  normalizeExecSafeBinProfilesInConfig(next);
  return asRuntimeConfig(next);
}
