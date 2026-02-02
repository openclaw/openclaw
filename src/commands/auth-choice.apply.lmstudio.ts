import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyPrimaryModel } from "./model-picker.js";

const DEFAULT_LMSTUDIO_BASE_URL = "http://127.0.0.1:1234";
const DEFAULT_LMSTUDIO_API = "openai-responses";
const DEFAULT_CONTEXT_WINDOW = 8192;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MODEL_INPUT = ["text"] satisfies Array<"text" | "image">;

function hasScheme(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.startsWith("localhost:") ||
    normalized.startsWith("127.") ||
    normalized === "::1" ||
    normalized.startsWith("[::1]")
  );
}

function normalizeLmStudioBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const hasUrlScheme = hasScheme(trimmed);
  const hostInput = (() => {
    try {
      return hasUrlScheme ? new URL(trimmed).hostname : new URL(`http://${trimmed}`).hostname;
    } catch {
      return trimmed.split("/")[0] ?? trimmed;
    }
  })();
  const defaultScheme = isLoopbackHost(hostInput) ? "http" : "https";
  const withScheme = hasUrlScheme ? trimmed : `${defaultScheme}://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  const path = url.pathname.replace(/\/+$/g, "");
  if (!path || path === "/") {
    url.pathname = "/v1";
  } else if (path === "/v1" || path.startsWith("/v1/")) {
    url.pathname = path;
  } else {
    url.pathname = `${path}/v1`;
  }

  return url.toString().replace(/\/+$/g, "");
}

function normalizeLmStudioModelId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const withoutPrefix = trimmed.replace(/^lmstudio\//i, "");
  return withoutPrefix;
}

export async function applyAuthChoiceLmStudio(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "lmstudio") {
    return null;
  }

  const existingProvider = params.config.models?.providers?.lmstudio;
  const baseUrlDefault = existingProvider?.baseUrl ?? `${DEFAULT_LMSTUDIO_BASE_URL}/v1`;
  const baseUrlInput = await params.prompter.text({
    message: "LM Studio base URL (host:port or full URL)",
    initialValue: baseUrlDefault,
    placeholder: `${DEFAULT_LMSTUDIO_BASE_URL}/v1`,
    validate: (value) =>
      normalizeLmStudioBaseUrl(String(value ?? "")) ? undefined : "Enter a valid host:port or URL",
  });
  const normalizedBaseUrl = normalizeLmStudioBaseUrl(String(baseUrlInput));
  if (!normalizedBaseUrl) {
    throw new Error("Invalid LM Studio base URL");
  }

  const configuredRaw =
    typeof params.config.agents?.defaults?.model === "string"
      ? params.config.agents.defaults.model
      : params.config.agents?.defaults?.model?.primary;
  const providerModelDefault = Array.isArray(existingProvider?.models)
    ? existingProvider?.models?.[0]?.id
    : undefined;
  const modelDefault = configuredRaw?.startsWith("lmstudio/")
    ? configuredRaw.replace(/^lmstudio\//, "")
    : providerModelDefault;

  const modelInput = await params.prompter.text({
    message: "LM Studio model id",
    initialValue: modelDefault,
    placeholder: "gpt-oss-20b",
    validate: (value) =>
      normalizeLmStudioModelId(String(value ?? "")) ? undefined : "Enter a model id",
  });
  const modelId = normalizeLmStudioModelId(String(modelInput));
  if (!modelId) {
    throw new Error("Invalid LM Studio model id");
  }
  const modelRef = `lmstudio/${modelId}`;

  const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
  const hasModel = existingModels.some((model) => model.id === modelId);
  const resolvedModels = hasModel
    ? existingModels
    : [
        ...existingModels,
        {
          id: modelId,
          name: modelId,
          reasoning: false,
          input: DEFAULT_MODEL_INPUT,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxTokens: DEFAULT_MAX_TOKENS,
        },
      ];
  const nextProvider: ModelProviderConfig = {
    ...(existingProvider ?? {
      baseUrl: normalizedBaseUrl,
      api: DEFAULT_LMSTUDIO_API,
      models: resolvedModels,
    }),
    baseUrl: normalizedBaseUrl,
    apiKey: existingProvider?.apiKey,
    api: existingProvider?.api ?? DEFAULT_LMSTUDIO_API,
    models: resolvedModels,
  };

  let nextConfig: OpenClawConfig = {
    ...params.config,
    models: {
      mode: params.config.models?.mode ?? "merge",
      providers: {
        ...params.config.models?.providers,
        lmstudio: nextProvider,
      },
    },
  };

  if (params.setDefaultModel) {
    nextConfig = applyPrimaryModel(nextConfig, modelRef);
    await params.prompter.note(`Default model set to ${modelRef}.`, "Model configured");
    return { config: nextConfig, agentModelOverride: params.agentId ? modelRef : undefined };
  }
  return { config: nextConfig, agentModelOverride: params.agentId ? modelRef : undefined };
}
