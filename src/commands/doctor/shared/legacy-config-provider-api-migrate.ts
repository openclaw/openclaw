import { MODEL_APIS } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isRecord } from "./legacy-config-record-shared.js";

/**
 * Known stale `api` values and their modern replacements.
 * When the `api` enum was refined (e.g. `"openai"` split into
 * `"openai-completions"` / `"openai-responses"` / `"openai-codex-responses"`),
 * configs retaining old values would cause a fatal validation error on startup.
 * This mapping allows `doctor --fix` to migrate them automatically.
 */
const STALE_PROVIDER_API_MIGRATIONS: Record<string, string | undefined> = {
  openai: "openai-completions",
};

export function normalizeLegacyProviderApi(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  const rawModels = cfg.models;
  if (!isRecord(rawModels) || !isRecord(rawModels.providers)) {
    return cfg;
  }

  const validApis = new Set<string>(MODEL_APIS);
  let providersChanged = false;
  const nextProviders = { ...rawModels.providers };

  for (const [providerId, rawProvider] of Object.entries(rawModels.providers)) {
    if (!isRecord(rawProvider) || !("api" in rawProvider)) {
      continue;
    }

    const currentApi = rawProvider.api;
    if (typeof currentApi !== "string") {
      continue;
    }

    // Already valid — no migration needed
    if (validApis.has(currentApi)) {
      continue;
    }

    const replacement = STALE_PROVIDER_API_MIGRATIONS[currentApi];
    if (!replacement) {
      // Unknown stale value — skip; will be caught by config validation
      continue;
    }

    nextProviders[providerId] = {
      ...rawProvider,
      api: replacement,
    } as (typeof nextProviders)[string];
    providersChanged = true;
    changes.push(`Migrated models.providers.${providerId}.api "${currentApi}" → "${replacement}".`);
  }

  if (!providersChanged) {
    return cfg;
  }

  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: nextProviders as NonNullable<OpenClawConfig["models"]>["providers"],
    },
  };
}
