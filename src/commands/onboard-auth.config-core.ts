import { buildKilocodeProvider } from "../../extensions/kilocode/provider-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import { KILOCODE_BASE_URL } from "../providers/kilocode-shared.js";
import { KILOCODE_DEFAULT_MODEL_REF, ZAI_DEFAULT_MODEL_REF } from "./onboard-auth.credentials.js";
export {
  applyCloudflareAiGatewayConfig,
  applyCloudflareAiGatewayProviderConfig,
  applyVercelAiGatewayConfig,
  applyVercelAiGatewayProviderConfig,
} from "./onboard-auth.config-gateways.js";
export {
  applyLitellmConfig,
  applyLitellmProviderConfig,
  LITELLM_BASE_URL,
  LITELLM_DEFAULT_MODEL_ID,
} from "./onboard-auth.config-litellm.js";
import {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
  applyProviderConfigWithModelCatalog,
} from "./onboard-auth.config-shared.js";
import {
  buildZaiModelDefinition,
  buildModelStudioModelDefinition,
  ZAI_DEFAULT_MODEL_ID,
  resolveZaiBaseUrl,
  MODELSTUDIO_CN_BASE_URL,
  MODELSTUDIO_GLOBAL_BASE_URL,
  MODELSTUDIO_DEFAULT_MODEL_REF,
} from "./onboard-auth.models.js";
export {
  applyHuggingfaceConfig,
  applyHuggingfaceProviderConfig,
  HUGGINGFACE_DEFAULT_MODEL_REF,
} from "../../extensions/huggingface/onboard.js";
export {
  applyKimiCodeConfig,
  applyKimiCodeProviderConfig,
} from "../../extensions/kimi-coding/onboard.js";
export {
  applyMistralConfig,
  applyMistralProviderConfig,
  MISTRAL_DEFAULT_MODEL_REF,
} from "../../extensions/mistral/onboard.js";
export {
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  applyMoonshotProviderConfig,
  applyMoonshotProviderConfigCn,
} from "../../extensions/moonshot/onboard.js";
export {
  applyOpenrouterConfig,
  applyOpenrouterProviderConfig,
} from "../../extensions/openrouter/onboard.js";
export {
  applyQianfanConfig,
  applyQianfanProviderConfig,
} from "../../extensions/qianfan/onboard.js";
export {
  applySyntheticConfig,
  applySyntheticProviderConfig,
  SYNTHETIC_DEFAULT_MODEL_REF,
} from "../../extensions/synthetic/onboard.js";
export {
  applyTogetherConfig,
  applyTogetherProviderConfig,
  TOGETHER_DEFAULT_MODEL_REF,
} from "../../extensions/together/onboard.js";
export {
  applyVeniceConfig,
  applyVeniceProviderConfig,
  VENICE_DEFAULT_MODEL_REF,
} from "../../extensions/venice/onboard.js";
export { applyXiaomiConfig, applyXiaomiProviderConfig } from "../../extensions/xiaomi/onboard.js";
export {
  applyXaiConfig,
  applyXaiProviderConfig,
  XAI_DEFAULT_MODEL_REF,
} from "../../extensions/xai/onboard.js";
export { applyAuthProfileConfig } from "./auth-profile-config.js";

function mergeProviderModels<T extends { id: string }>(
  existingProvider: Record<string, unknown> | undefined,
  defaultModels: T[],
): T[] {
  const existingModels = Array.isArray(existingProvider?.models)
    ? (existingProvider.models as T[])
    : [];
  const mergedModels = [...existingModels];
  const seen = new Set(existingModels.map((model) => model.id));
  for (const model of defaultModels) {
    if (!seen.has(model.id)) {
      mergedModels.push(model);
      seen.add(model.id);
    }
  }
  return mergedModels;
}

function getNormalizedProviderApiKey(existingProvider: Record<string, unknown> | undefined) {
  const { apiKey } = (existingProvider ?? {}) as { apiKey?: string };
  return typeof apiKey === "string" ? apiKey.trim() || undefined : undefined;
}

export function applyZaiProviderConfig(
  cfg: OpenClawConfig,
  params?: { endpoint?: string; modelId?: string },
): OpenClawConfig {
  const modelId = params?.modelId?.trim() || ZAI_DEFAULT_MODEL_ID;
  const modelRef = `zai/${modelId}`;

  const models = { ...cfg.agents?.defaults?.models };
  models[modelRef] = {
    ...models[modelRef],
    alias: models[modelRef]?.alias ?? "GLM",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.zai;

  const defaultModels = [
    buildZaiModelDefinition({ id: "glm-5" }),
    buildZaiModelDefinition({ id: "glm-5-turbo" }),
    buildZaiModelDefinition({ id: "glm-4.7" }),
    buildZaiModelDefinition({ id: "glm-4.7-flash" }),
    buildZaiModelDefinition({ id: "glm-4.7-flashx" }),
  ];

  const mergedModels = mergeProviderModels(existingProvider, defaultModels);

  const { apiKey: _existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const normalizedApiKey = getNormalizedProviderApiKey(existingProvider);

  const baseUrl = params?.endpoint
    ? resolveZaiBaseUrl(params.endpoint)
    : (typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl : "") ||
      resolveZaiBaseUrl();

  providers.zai = {
    ...existingProviderRest,
    baseUrl,
    api: "openai-completions",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : defaultModels,
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, { agentModels: models, providers });
}

export function applyZaiConfig(
  cfg: OpenClawConfig,
  params?: { endpoint?: string; modelId?: string },
): OpenClawConfig {
  const modelId = params?.modelId?.trim() || ZAI_DEFAULT_MODEL_ID;
  const modelRef = modelId === ZAI_DEFAULT_MODEL_ID ? ZAI_DEFAULT_MODEL_REF : `zai/${modelId}`;
  const next = applyZaiProviderConfig(cfg, params);
  return applyAgentDefaultModelPrimary(next, modelRef);
}

export { KILOCODE_BASE_URL };

/**
 * Apply Kilo Gateway provider configuration without changing the default model.
 * Registers Kilo Gateway and sets up the provider, but preserves existing model selection.
 */
export function applyKilocodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[KILOCODE_DEFAULT_MODEL_REF] = {
    ...models[KILOCODE_DEFAULT_MODEL_REF],
    alias: models[KILOCODE_DEFAULT_MODEL_REF]?.alias ?? "Kilo Gateway",
  };

  const kilocodeModels = buildKilocodeProvider().models ?? [];

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "kilocode",
    api: "openai-completions",
    baseUrl: KILOCODE_BASE_URL,
    catalogModels: kilocodeModels,
  });
}

/**
 * Apply Kilo Gateway provider configuration AND set Kilo Gateway as the default model.
 * Use this when Kilo Gateway is the primary provider choice during setup.
 */
export function applyKilocodeConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyKilocodeProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, KILOCODE_DEFAULT_MODEL_REF);
}

// Alibaba Cloud Model Studio Coding Plan

function applyModelStudioProviderConfigWithBaseUrl(
  cfg: OpenClawConfig,
  baseUrl: string,
): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };

  const modelStudioModelIds = [
    "qwen3.5-plus",
    "qwen3-max-2026-01-23",
    "qwen3-coder-next",
    "qwen3-coder-plus",
    "MiniMax-M2.5",
    "glm-5",
    "glm-4.7",
    "kimi-k2.5",
  ];
  for (const modelId of modelStudioModelIds) {
    const modelRef = `modelstudio/${modelId}`;
    if (!models[modelRef]) {
      models[modelRef] = {};
    }
  }
  models[MODELSTUDIO_DEFAULT_MODEL_REF] = {
    ...models[MODELSTUDIO_DEFAULT_MODEL_REF],
    alias: models[MODELSTUDIO_DEFAULT_MODEL_REF]?.alias ?? "Qwen",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.modelstudio;

  const defaultModels = [
    buildModelStudioModelDefinition({ id: "qwen3.5-plus" }),
    buildModelStudioModelDefinition({ id: "qwen3-max-2026-01-23" }),
    buildModelStudioModelDefinition({ id: "qwen3-coder-next" }),
    buildModelStudioModelDefinition({ id: "qwen3-coder-plus" }),
    buildModelStudioModelDefinition({ id: "MiniMax-M2.5" }),
    buildModelStudioModelDefinition({ id: "glm-5" }),
    buildModelStudioModelDefinition({ id: "glm-4.7" }),
    buildModelStudioModelDefinition({ id: "kimi-k2.5" }),
  ];

  const mergedModels = mergeProviderModels(existingProvider, defaultModels);

  const { apiKey: _existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const normalizedApiKey = getNormalizedProviderApiKey(existingProvider);

  providers.modelstudio = {
    ...existingProviderRest,
    baseUrl,
    api: "openai-completions",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    models: mergedModels.length > 0 ? mergedModels : defaultModels,
  };

  return applyOnboardAuthAgentModelsAndProviders(cfg, { agentModels: models, providers });
}

export function applyModelStudioProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyModelStudioProviderConfigWithBaseUrl(cfg, MODELSTUDIO_GLOBAL_BASE_URL);
}

export function applyModelStudioProviderConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return applyModelStudioProviderConfigWithBaseUrl(cfg, MODELSTUDIO_CN_BASE_URL);
}

export function applyModelStudioConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyModelStudioProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, MODELSTUDIO_DEFAULT_MODEL_REF);
}

export function applyModelStudioConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyModelStudioProviderConfigCn(cfg);
  return applyAgentDefaultModelPrimary(next, MODELSTUDIO_DEFAULT_MODEL_REF);
}
