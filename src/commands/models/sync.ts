import { getModel, type Model } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelApi, ModelDefinitionConfig } from "../../config/types.models.js";
import type { RuntimeEnv } from "../../runtime.js";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { ensureOpenClawModelsJson } from "../../agents/models-config.js";
import {
  buildOpenRouterModelDefinition,
  fetchOpenRouterModels,
  isFreeOpenRouterModel,
  type OpenRouterModelMeta,
} from "../../agents/openrouter-catalog.js";
import { withProgressTotals } from "../../cli/progress.js";
import { loadConfig } from "../../config/config.js";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_API_KEY_REF = "OPENROUTER_API_KEY";
const DEFAULT_OPENROUTER_API: ModelApi = "openai-completions";

const PROGRESS_STEP = 50;

type ModelsJson = {
  providers?: Record<string, ModelsJsonProvider>;
};

type ModelsJsonProvider = {
  baseUrl?: string;
  apiKey?: string;
  api?: ModelApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: ModelDefinitionConfig[];
};

function normalizeProviderFilter(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.toLowerCase();
}

async function readModelsJson(filePath: string): Promise<ModelsJson> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) {
      return { providers: {} };
    }
    const parsed = JSON.parse(raw) as ModelsJson;
    if (!parsed || typeof parsed !== "object") {
      return { providers: {} };
    }
    return parsed;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return { providers: {} };
    }
    throw err;
  }
}

async function writeModelsJson(filePath: string, payload: ModelsJson): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const raw = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(filePath, raw, { mode: 0o600 });
}

function buildOpenRouterAutoModel(
  baseModel: Model<"openai-completions"> | undefined,
): ModelDefinitionConfig {
  if (!baseModel) {
    throw new Error("Missing base OpenRouter model (openrouter/auto).");
  }
  return {
    id: baseModel.id,
    name: baseModel.name || baseModel.id,
    reasoning: baseModel.reasoning ?? false,
    input: baseModel.input ?? ["text"],
    cost: baseModel.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: baseModel.contextWindow ?? 1,
    maxTokens: baseModel.maxTokens ?? 1,
  } satisfies ModelDefinitionConfig;
}

function filterOpenRouterCatalog(params: {
  catalog: OpenRouterModelMeta[];
  providerFilter?: string;
  freeOnly?: boolean;
}) {
  const providerFilter = normalizeProviderFilter(params.providerFilter);
  return params.catalog.filter((entry) => {
    if (params.freeOnly && !isFreeOpenRouterModel(entry)) {
      return false;
    }
    if (providerFilter) {
      const prefix = entry.id.split("/")[0]?.toLowerCase() ?? "";
      if (prefix !== providerFilter) {
        return false;
      }
    }
    return true;
  });
}

export async function modelsSyncOpenRouterCommand(
  opts: {
    provider?: string;
    freeOnly?: boolean;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const cfg = loadConfig();
  await ensureOpenClawModelsJson(cfg);

  const baseModel = getModel("openrouter", "openrouter/auto") as
    | Model<"openai-completions">
    | undefined;
  if (!baseModel) {
    throw new Error("Missing built-in OpenRouter base model definition.");
  }

  const { models, filteredCount } = await withProgressTotals(
    {
      label: "Fetching OpenRouter models...",
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async (update, progress) => {
      const catalog = await fetchOpenRouterModels(fetch);
      const filtered = filterOpenRouterCatalog({
        catalog,
        providerFilter: opts.provider,
        freeOnly: opts.freeOnly,
      }).toSorted((a, b) => a.id.localeCompare(b.id));
      progress.setLabel(`Building OpenRouter catalog (${filtered.length})`);
      const total = filtered.length + 1;
      let completed = 0;
      const nextModels: ModelDefinitionConfig[] = [];

      for (const entry of filtered) {
        nextModels.push(buildOpenRouterModelDefinition({ entry, baseModel }));
        completed += 1;
        if (completed % PROGRESS_STEP === 0 || completed === total) {
          update({ completed, total });
        }
      }

      const autoModel = buildOpenRouterAutoModel(baseModel);
      if (!nextModels.some((entry) => entry.id === autoModel.id)) {
        nextModels.unshift(autoModel);
      }

      update({ completed: total, total });
      return { models: nextModels, filteredCount: filtered.length };
    },
  );

  const agentDir = resolveOpenClawAgentDir();
  const modelsPath = path.join(agentDir, "models.json");
  const existing = await readModelsJson(modelsPath);
  const providers = existing.providers ? { ...existing.providers } : {};
  const existingProvider = providers.openrouter ?? {};

  providers.openrouter = {
    baseUrl: existingProvider.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
    apiKey: existingProvider.apiKey ?? DEFAULT_OPENROUTER_API_KEY_REF,
    api: existingProvider.api ?? DEFAULT_OPENROUTER_API,
    headers: existingProvider.headers,
    authHeader: existingProvider.authHeader,
    models,
  } satisfies ModelsJsonProvider;

  const nextPayload: ModelsJson = {
    ...existing,
    providers,
  };

  await writeModelsJson(modelsPath, nextPayload);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          ok: true,
          provider: "openrouter",
          modelCount: models.length,
          filteredCount,
          path: modelsPath,
          freeOnly: Boolean(opts.freeOnly),
          providerFilter: normalizeProviderFilter(opts.provider) ?? null,
          restartRequired: true,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(`Synced ${models.length} OpenRouter models to ${modelsPath}.`);
  if (opts.freeOnly) {
    runtime.log(`Filter: free-only (${filteredCount} OpenRouter catalog entries).`);
  } else if (opts.provider) {
    runtime.log(
      `Filter: provider=${normalizeProviderFilter(opts.provider)} (${filteredCount} entries).`,
    );
  }
  runtime.log("Restart the gateway to pick up the updated catalog.");
}
