import { upsertAuthProfileWithLock } from "../agents/auth-profiles.js";
import type { ApiKeyCredential, AuthProfileCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  ProviderDiscoveryContext,
  ProviderAuthResult,
  ProviderAuthMethodNonInteractiveContext,
  ProviderNonInteractiveApiKeyResult,
} from "../plugins/types.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthProfileConfig } from "./onboard-auth.js";

export const SELF_HOSTED_DEFAULT_CONTEXT_WINDOW = 128000;
export const SELF_HOSTED_DEFAULT_MAX_TOKENS = 8192;
export const SELF_HOSTED_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export function applyProviderDefaultModel(cfg: OpenClawConfig, modelRef: string): OpenClawConfig {
  const existingModel = cfg.agents?.defaults?.model;
  const fallbacks =
    existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: modelRef,
        },
      },
    },
  };
}

function buildOpenAICompatibleSelfHostedProviderConfig(params: {
  cfg: OpenClawConfig;
  providerId: string;
  baseUrl: string;
  providerApiKey: string;
  modelId: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): { config: OpenClawConfig; modelId: string; modelRef: string; profileId: string } {
  const modelRef = `${params.providerId}/${params.modelId}`;
  const profileId = `${params.providerId}:default`;
  return {
    config: {
      ...params.cfg,
      models: {
        ...params.cfg.models,
        mode: params.cfg.models?.mode ?? "merge",
        providers: {
          ...params.cfg.models?.providers,
          [params.providerId]: {
            baseUrl: params.baseUrl,
            api: "openai-completions",
            apiKey: params.providerApiKey,
            models: [
              {
                id: params.modelId,
                name: params.modelId,
                reasoning: params.reasoning ?? false,
                input: params.input ?? ["text"],
                cost: SELF_HOSTED_DEFAULT_COST,
                contextWindow: params.contextWindow ?? SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
                maxTokens: params.maxTokens ?? SELF_HOSTED_DEFAULT_MAX_TOKENS,
              },
            ],
          },
        },
      },
    },
    modelId: params.modelId,
    modelRef,
    profileId,
  };
}

type OpenAICompatibleSelfHostedProviderSetupParams = {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  providerId: string;
  providerLabel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnvVar: string;
  modelPlaceholder: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

type OpenAICompatibleSelfHostedProviderPromptResult = {
  config: OpenClawConfig;
  credential: AuthProfileCredential;
  modelId: string;
  modelRef: string;
  profileId: string;
};

function buildSelfHostedProviderAuthResult(
  result: OpenAICompatibleSelfHostedProviderPromptResult,
): ProviderAuthResult {
  return {
    profiles: [
      {
        profileId: result.profileId,
        credential: result.credential,
      },
    ],
    configPatch: result.config,
    defaultModel: result.modelRef,
  };
}

export async function promptAndConfigureOpenAICompatibleSelfHostedProvider(
  params: OpenAICompatibleSelfHostedProviderSetupParams,
): Promise<OpenAICompatibleSelfHostedProviderPromptResult> {
  const baseUrlRaw = await params.prompter.text({
    message: `${params.providerLabel} base URL`,
    initialValue: params.defaultBaseUrl,
    placeholder: params.defaultBaseUrl,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const apiKeyRaw = await params.prompter.text({
    message: `${params.providerLabel} API key`,
    placeholder: "sk-... (or any non-empty string)",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const modelIdRaw = await params.prompter.text({
    message: `${params.providerLabel} model`,
    placeholder: params.modelPlaceholder,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  const baseUrl = String(baseUrlRaw ?? "")
    .trim()
    .replace(/\/+$/, "");
  const apiKey = String(apiKeyRaw ?? "").trim();
  const modelId = String(modelIdRaw ?? "").trim();
  const credential: AuthProfileCredential = {
    type: "api_key",
    provider: params.providerId,
    key: apiKey,
  };
  const configured = buildOpenAICompatibleSelfHostedProviderConfig({
    cfg: params.cfg,
    providerId: params.providerId,
    baseUrl,
    providerApiKey: params.defaultApiKeyEnvVar,
    modelId,
    input: params.input,
    reasoning: params.reasoning,
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
  });

  return {
    config: configured.config,
    credential,
    modelId: configured.modelId,
    modelRef: configured.modelRef,
    profileId: configured.profileId,
  };
}

export async function promptAndConfigureOpenAICompatibleSelfHostedProviderAuth(
  params: OpenAICompatibleSelfHostedProviderSetupParams,
): Promise<ProviderAuthResult> {
  const result = await promptAndConfigureOpenAICompatibleSelfHostedProvider(params);
  return buildSelfHostedProviderAuthResult(result);
}

export async function discoverOpenAICompatibleSelfHostedProvider<
  T extends Record<string, unknown>,
>(params: {
  ctx: ProviderDiscoveryContext;
  providerId: string;
  buildProvider: (params: { apiKey?: string }) => Promise<T>;
}): Promise<{ provider: T & { apiKey: string } } | null> {
  if (params.ctx.config.models?.providers?.[params.providerId]) {
    return null;
  }
  const { apiKey, discoveryApiKey } = params.ctx.resolveProviderApiKey(params.providerId);
  if (!apiKey) {
    return null;
  }
  return {
    provider: {
      ...(await params.buildProvider({ apiKey: discoveryApiKey })),
      apiKey,
    },
  };
}

function buildMissingNonInteractiveModelIdMessage(params: {
  authChoice: string;
  providerLabel: string;
  modelPlaceholder: string;
}): string {
  return [
    `Missing --custom-model-id for --auth-choice ${params.authChoice}.`,
    `Pass the ${params.providerLabel} model id to use, for example ${params.modelPlaceholder}.`,
  ].join("\n");
}

function buildSelfHostedProviderCredential(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  resolved: ProviderNonInteractiveApiKeyResult;
}): ApiKeyCredential | null {
  return params.ctx.toApiKeyCredential({
    provider: params.providerId,
    resolved: params.resolved,
  });
}

export async function configureOpenAICompatibleSelfHostedProviderNonInteractive(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  providerLabel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnvVar: string;
  modelPlaceholder: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): Promise<OpenClawConfig | null> {
  const baseUrl = (params.ctx.opts.customBaseUrl?.trim() || params.defaultBaseUrl).replace(
    /\/+$/,
    "",
  );
  const modelId = params.ctx.opts.customModelId?.trim();
  if (!modelId) {
    params.ctx.runtime.error(
      buildMissingNonInteractiveModelIdMessage({
        authChoice: params.ctx.authChoice,
        providerLabel: params.providerLabel,
        modelPlaceholder: params.modelPlaceholder,
      }),
    );
    params.ctx.runtime.exit(1);
    return null;
  }

  const resolved = await params.ctx.resolveApiKey({
    provider: params.providerId,
    flagValue: params.ctx.opts.customApiKey,
    flagName: "--custom-api-key",
    envVar: params.defaultApiKeyEnvVar,
    envVarName: params.defaultApiKeyEnvVar,
  });
  if (!resolved) {
    return null;
  }

  const credential = buildSelfHostedProviderCredential({
    ctx: params.ctx,
    providerId: params.providerId,
    resolved,
  });
  if (!credential) {
    return null;
  }

  const configured = buildOpenAICompatibleSelfHostedProviderConfig({
    cfg: params.ctx.config,
    providerId: params.providerId,
    baseUrl,
    providerApiKey: params.defaultApiKeyEnvVar,
    modelId,
    input: params.input,
    reasoning: params.reasoning,
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
  });
  await upsertAuthProfileWithLock({
    profileId: configured.profileId,
    credential,
    agentDir: params.ctx.agentDir,
  });

  const withProfile = applyAuthProfileConfig(configured.config, {
    profileId: configured.profileId,
    provider: params.providerId,
    mode: "api_key",
  });
  params.ctx.runtime.log(`Default ${params.providerLabel} model: ${modelId}`);
  return applyProviderDefaultModel(withProfile, configured.modelRef);
}
