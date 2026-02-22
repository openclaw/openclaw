import {
  buildCloudflareAiGatewayModelDefinition,
  resolveCloudflareAiGatewayBaseUrl,
} from "../agents/cloudflare-ai-gateway.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
} from "./onboard-auth.config-shared.js";
import {
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
} from "./onboard-auth.credentials.js";

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

export function applyCloudflareAiGatewayConfig(
  cfg: OpenClawConfig,
  params?: { accountId?: string; gatewayId?: string },
): OpenClawConfig {
  const next = applyCloudflareAiGatewayProviderConfig(cfg, params);
  return applyAgentDefaultModelPrimary(next, CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF);
}
