import {
  buildCloudflareAiGatewayModelDefinition,
  resolveCloudflareAiGatewayBaseUrl,
} from "../agents/cloudflare-ai-gateway.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
} from "./onboard-auth.config-shared.js";
import {
  CENCORI_DEFAULT_MODEL_REF,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
} from "./onboard-auth.credentials.js";

const CENCORI_BASE_URL = "https://cencori.com/api/v1";
const CENCORI_DEFAULT_MODEL_ID = "gpt-4o";

function buildCencoriModelDefinition(): ModelDefinitionConfig {
  return {
    id: CENCORI_DEFAULT_MODEL_ID,
    name: "GPT-4o (via Cencori)",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2.5,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

export function applyCencoriProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[CENCORI_DEFAULT_MODEL_REF] = {
    ...models[CENCORI_DEFAULT_MODEL_REF],
    alias: models[CENCORI_DEFAULT_MODEL_REF]?.alias ?? "Cencori",
  };

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "cencori",
    api: "openai-completions",
    baseUrl: CENCORI_BASE_URL,
    defaultModel: buildCencoriModelDefinition(),
    defaultModelId: CENCORI_DEFAULT_MODEL_ID,
  });
}

export function applyVercelAiGatewayProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF] = {
    ...models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF],
    alias: models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF]?.alias ?? "Vercel AI Gateway",
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
  };
}

export function applyCloudflareAiGatewayProviderConfig(
  cfg: OpenClawConfig,
  params?: { accountId?: string; gatewayId?: string },
): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF] = {
    ...models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF],
    alias: models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF]?.alias ?? "Cloudflare AI Gateway",
  };

  const defaultModel = buildCloudflareAiGatewayModelDefinition();
  const existingProvider = cfg.models?.providers?.["cloudflare-ai-gateway"] as
    | { baseUrl?: unknown }
    | undefined;
  const baseUrl =
    params?.accountId && params?.gatewayId
      ? resolveCloudflareAiGatewayBaseUrl({
          accountId: params.accountId,
          gatewayId: params.gatewayId,
        })
      : typeof existingProvider?.baseUrl === "string"
        ? existingProvider.baseUrl
        : undefined;

  if (!baseUrl) {
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models,
        },
      },
    };
  }

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "cloudflare-ai-gateway",
    api: "anthropic-messages",
    baseUrl,
    defaultModel,
  });
}

export function applyVercelAiGatewayConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyVercelAiGatewayProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF);
}

export function applyCencoriConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyCencoriProviderConfig(cfg);
  return applyAgentDefaultModelPrimary(next, CENCORI_DEFAULT_MODEL_REF);
}

export function applyCloudflareAiGatewayConfig(
  cfg: OpenClawConfig,
  params?: { accountId?: string; gatewayId?: string },
): OpenClawConfig {
  const next = applyCloudflareAiGatewayProviderConfig(cfg, params);
  return applyAgentDefaultModelPrimary(next, CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF);
}
