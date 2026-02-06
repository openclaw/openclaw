import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelRow } from "./list.types.js";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { listProfilesForProvider } from "../../agents/auth-profiles.js";
import {
  getCustomProviderApiKey,
  resolveAwsSdkEnvVarName,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import { ensureOpenClawModelsJson } from "../../agents/models-config.js";
import { discoverAuthStorage, discoverModels } from "../../agents/pi-model-discovery.js";
import { modelKey } from "./shared.js";

const isLocalBaseUrl = (baseUrl: string) => {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
};

const hasAuthForProvider = (provider: string, cfg: OpenClawConfig, authStore: AuthProfileStore) => {
  if (listProfilesForProvider(authStore, provider).length > 0) {
    return true;
  }
  if (provider === "amazon-bedrock" && resolveAwsSdkEnvVarName()) {
    return true;
  }
  if (resolveEnvApiKey(provider)) {
    return true;
  }
  if (getCustomProviderApiKey(cfg, provider)) {
    return true;
  }
  return false;
};

/** Provider defaults for synthetic Model<Api> objects built from catalog entries. */
const PROVIDER_DEFAULTS: Record<
  string,
  { api: Api; baseUrl: string; contextWindow: number; maxTokens: number }
> = {
  anthropic: {
    api: "anthropic-messages" as Api,
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200_000,
    maxTokens: 8192,
  },
  openai: {
    api: "openai-responses" as Api,
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
};

/**
 * Create a synthetic Model<Api> from a ModelCatalogEntry so that models
 * discovered via the supplemental API (Anthropic /v1/models, OpenAI /v1/models)
 * appear with proper metadata in `models list` instead of showing as "missing".
 */
function catalogEntryToModel(entry: ModelCatalogEntry): Model<Api> {
  const fallback = PROVIDER_DEFAULTS.openai;
  const defaults = PROVIDER_DEFAULTS[entry.provider] ?? fallback;
  return {
    id: entry.id,
    name: entry.name,
    api: defaults.api,
    provider: entry.provider,
    baseUrl: defaults.baseUrl,
    reasoning: entry.reasoning ?? false,
    input: entry.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

export async function loadModelRegistry(cfg: OpenClawConfig) {
  await ensureOpenClawModelsJson(cfg);
  const agentDir = resolveOpenClawAgentDir();
  const authStorage = discoverAuthStorage(agentDir);
  const registry = discoverModels(authStorage, agentDir);
  const models = registry.getAll();
  const availableModels = registry.getAvailable();
  const availableKeys = new Set(availableModels.map((model) => modelKey(model.provider, model.id)));

  // Inject supplemental models discovered via provider APIs (Anthropic, OpenAI).
  // These fill gaps where pi-ai's static catalog hasn't been updated yet.
  const existingKeys = new Set(models.map((m) => modelKey(m.provider, m.id)));
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    for (const entry of catalog) {
      const key = modelKey(entry.provider, entry.id);
      if (!existingKeys.has(key)) {
        models.push(catalogEntryToModel(entry));
        existingKeys.add(key);
        // The model was discovered via API, so auth is valid.
        availableKeys.add(key);
      }
    }
  } catch {
    // Supplemental catalog unavailable — continue with registry models only.
  }

  return { registry, models, availableKeys };
}

export function toModelRow(params: {
  model?: Model<Api>;
  key: string;
  tags: string[];
  aliases?: string[];
  availableKeys?: Set<string>;
  cfg?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): ModelRow {
  const { model, key, tags, aliases = [], availableKeys, cfg, authStore } = params;
  if (!model) {
    return {
      key,
      name: key,
      input: "-",
      contextWindow: null,
      local: null,
      available: null,
      tags: [...tags, "missing"],
      missing: true,
    };
  }

  const input = model.input.join("+") || "text";
  const local = isLocalBaseUrl(model.baseUrl);
  const available =
    cfg && authStore
      ? hasAuthForProvider(model.provider, cfg, authStore)
      : (availableKeys?.has(modelKey(model.provider, model.id)) ?? false);
  const aliasTags = aliases.length > 0 ? [`alias:${aliases.join(",")}`] : [];
  const mergedTags = new Set(tags);
  if (aliasTags.length > 0) {
    for (const tag of mergedTags) {
      if (tag === "alias" || tag.startsWith("alias:")) {
        mergedTags.delete(tag);
      }
    }
    for (const tag of aliasTags) {
      mergedTags.add(tag);
    }
  }

  return {
    key,
    name: model.name || model.id,
    input,
    contextWindow: model.contextWindow ?? null,
    local,
    available,
    tags: Array.from(mergedTags),
    missing: false,
  };
}
