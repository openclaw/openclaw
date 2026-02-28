import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export const VIVGRID_BASE_URL = "https://api.vivgrid.com/v1";
export const VIVGRID_DEFAULT_MODEL_ID = "gpt-5-mini";
const VIVGRID_DEFAULT_CONTEXT_WINDOW = 262144;
const VIVGRID_DEFAULT_MAX_TOKENS = 32768;
const VIVGRID_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type VivgridModelEntry = {
  id?: string;
  supported_apis?: unknown;
  apis?: unknown;
  api_types?: unknown;
  capabilities?: {
    responses?: unknown;
    completions?: unknown;
    chat_completions?: unknown;
    anthropic_messages?: unknown;
  };
};

type VivgridModelsResponse = {
  data?: VivgridModelEntry[];
};

const log = createSubsystemLogger("agents/model-providers");

function resolveDiscoveryApiKeyValue(apiKey?: string): string {
  if (!apiKey) {
    return "";
  }
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return "";
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) {
    return (process.env[trimmed] ?? "").trim();
  }
  return trimmed;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((item) => item.length > 0);
}

function inferVivgridModelApi(model: VivgridModelEntry): ModelDefinitionConfig["api"] | undefined {
  const lowerId = typeof model.id === "string" ? model.id.toLowerCase() : "";
  if (lowerId.includes("codex")) {
    return "openai-responses";
  }
  if (lowerId.includes("claude")) {
    return "anthropic-messages";
  }

  const apis = [
    ...toStringArray(model.supported_apis),
    ...toStringArray(model.apis),
    ...toStringArray(model.api_types),
  ];
  const hasAnthropicMessages = apis.some((api) => {
    return api.includes("anthropic-messages") || api.includes("anthropic/messages");
  });
  const hasResponses = apis.some((api) => api.includes("response"));
  const hasCompletions = apis.some(
    (api) => api.includes("completion") || api.includes("chat.completion"),
  );

  const caps = model.capabilities;
  const capsAnthropicMessages = caps?.anthropic_messages === true;
  const capsResponses = caps?.responses === true;
  const capsCompletions = caps?.completions === true || caps?.chat_completions === true;

  // Vivgrid /models currently only returns model id in most cases.
  // Keep metadata checks as optional forward-compatible signals.
  if (hasAnthropicMessages || capsAnthropicMessages) {
    return "anthropic-messages";
  }
  if ((hasResponses || capsResponses) && !(hasCompletions || capsCompletions)) {
    return "openai-responses";
  }
  if ((hasCompletions || capsCompletions) && !(hasResponses || capsResponses)) {
    return "openai-completions";
  }
  return undefined;
}

async function discoverVivgridModels(
  baseUrl: string,
  apiKey?: string,
): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return [];
  }

  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const url = `${trimmedBaseUrl}/models`;
  const resolvedApiKey = resolveDiscoveryApiKeyValue(apiKey);

  try {
    const response = await fetch(url, {
      headers: resolvedApiKey ? { Authorization: `Bearer ${resolvedApiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      log.warn(`Failed to discover Vivgrid models: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as VivgridModelsResponse;
    const models = Array.isArray(data.data) ? data.data : [];
    if (models.length === 0) {
      log.warn("No Vivgrid models found on remote instance");
      return [];
    }

    const discoveredModels = models
      .map((model) => ({
        id: typeof model.id === "string" ? model.id.trim() : "",
        api: inferVivgridModelApi(model),
      }))
      .filter((model) => Boolean(model.id))
      .map((model) => {
        const lower = model.id.toLowerCase();
        const isReasoning =
          lower.includes("r1") ||
          lower.includes("reason") ||
          lower.includes("think") ||
          lower.includes("codex");
        return {
          id: model.id,
          name: model.id,
          api: model.api,
          reasoning: isReasoning,
          input: ["text", "image"],
          cost: VIVGRID_DEFAULT_COST,
          contextWindow: VIVGRID_DEFAULT_CONTEXT_WINDOW,
          maxTokens: VIVGRID_DEFAULT_MAX_TOKENS,
        } satisfies ModelDefinitionConfig;
      });

    if (discoveredModels.length === 1) {
      const onlyModel = discoveredModels[0];
      const resolvedApi = onlyModel?.api ?? "openai-completions";
      log.info(`Vivgrid discovered model ${onlyModel?.id} (api: ${resolvedApi}).`);
    } else if (discoveredModels.length > 1) {
      log.info(
        `Vivgrid discovered ${discoveredModels.length} models; API is determined by the selected model.`,
      );
    }

    return discoveredModels;
  } catch (error) {
    log.warn(`Failed to discover Vivgrid models: ${String(error)}`);
    return [];
  }
}

export function buildVivgridProvider(): ProviderConfig {
  return {
    baseUrl: VIVGRID_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: VIVGRID_DEFAULT_MODEL_ID,
        name: "Vivgrid GPT-5 mini",
        reasoning: true,
        input: ["text", "image"],
        cost: VIVGRID_DEFAULT_COST,
        contextWindow: VIVGRID_DEFAULT_CONTEXT_WINDOW,
        maxTokens: VIVGRID_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

export async function buildVivgridProviderWithDiscovery(params?: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig> {
  const baseUrl = (params?.baseUrl?.trim() || VIVGRID_BASE_URL).replace(/\/+$/, "");
  const discoveredModels = await discoverVivgridModels(baseUrl, params?.apiKey);
  return {
    baseUrl,
    api: "openai-completions",
    models: discoveredModels.length > 0 ? discoveredModels : buildVivgridProvider().models,
  };
}
