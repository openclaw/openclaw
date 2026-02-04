import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import {
  applyGoogleGeminiModelDefault,
  GOOGLE_GEMINI_DEFAULT_MODEL,
} from "./google-gemini-model-default.js";
import {
  applyAuthProfileConfig,
  applyAzureOpenAiConfig,
  applyAzureOpenAiProviderConfig,
  applyCloudflareAiGatewayConfig,
  applyCloudflareAiGatewayProviderConfig,
  applyKimiCodeConfig,
  applyKimiCodeProviderConfig,
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  applyMoonshotProviderConfig,
  applyMoonshotProviderConfigCn,
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
  applyOpenrouterConfig,
  applyOpenrouterProviderConfig,
  applySyntheticConfig,
  applySyntheticProviderConfig,
  applyVeniceConfig,
  applyVeniceProviderConfig,
  applyVercelAiGatewayConfig,
  applyVercelAiGatewayProviderConfig,
  applyXiaomiConfig,
  applyXiaomiProviderConfig,
  applyZaiConfig,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  KIMI_CODING_MODEL_REF,
  MOONSHOT_DEFAULT_MODEL_REF,
  OPENROUTER_DEFAULT_MODEL_REF,
  SYNTHETIC_DEFAULT_MODEL_REF,
  VENICE_DEFAULT_MODEL_REF,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  XIAOMI_DEFAULT_MODEL_REF,
  setCloudflareAiGatewayConfig,
  setGeminiApiKey,
  setKimiCodingApiKey,
  setMoonshotApiKey,
  setOpencodeZenApiKey,
  setOpenrouterApiKey,
  setSyntheticApiKey,
  setVeniceApiKey,
  setVercelAiGatewayApiKey,
  setXiaomiApiKey,
  setZaiApiKey,
  ZAI_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";
import { OPENCODE_ZEN_DEFAULT_MODEL } from "./opencode-zen-model-default.js";

export async function applyAuthChoiceApiProviders(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = async (model: string) => {
    if (!params.agentId) {
      return;
    }
    await params.prompter.note(
      `Default model set to ${model} for agent "${params.agentId}".`,
      "Model configured",
    );
  };

  let authChoice = params.authChoice;
  if (
    authChoice === "apiKey" &&
    params.opts?.tokenProvider &&
    params.opts.tokenProvider !== "anthropic" &&
    params.opts.tokenProvider !== "openai"
  ) {
    if (params.opts.tokenProvider === "openrouter") {
      authChoice = "openrouter-api-key";
    } else if (params.opts.tokenProvider === "vercel-ai-gateway") {
      authChoice = "ai-gateway-api-key";
    } else if (params.opts.tokenProvider === "cloudflare-ai-gateway") {
      authChoice = "cloudflare-ai-gateway-api-key";
    } else if (params.opts.tokenProvider === "moonshot") {
      authChoice = "moonshot-api-key";
    } else if (
      params.opts.tokenProvider === "kimi-code" ||
      params.opts.tokenProvider === "kimi-coding"
    ) {
      authChoice = "kimi-code-api-key";
    } else if (params.opts.tokenProvider === "google") {
      authChoice = "gemini-api-key";
    } else if (params.opts.tokenProvider === "zai") {
      authChoice = "zai-api-key";
    } else if (params.opts.tokenProvider === "xiaomi") {
      authChoice = "xiaomi-api-key";
    } else if (params.opts.tokenProvider === "synthetic") {
      authChoice = "synthetic-api-key";
    } else if (params.opts.tokenProvider === "venice") {
      authChoice = "venice-api-key";
    } else if (params.opts.tokenProvider === "opencode") {
      authChoice = "opencode-zen";
    }
  }

  if (authChoice === "openrouter-api-key") {
    const store = ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    });
    const profileOrder = resolveAuthProfileOrder({
      cfg: nextConfig,
      store,
      provider: "openrouter",
    });
    const existingProfileId = profileOrder.find((profileId) => Boolean(store.profiles[profileId]));
    const existingCred = existingProfileId ? store.profiles[existingProfileId] : undefined;
    let profileId = "openrouter:default";
    let mode: "api_key" | "oauth" | "token" = "api_key";
    let hasCredential = false;

    if (existingProfileId && existingCred?.type) {
      profileId = existingProfileId;
      mode =
        existingCred.type === "oauth"
          ? "oauth"
          : existingCred.type === "token"
            ? "token"
            : "api_key";
      hasCredential = true;
    }

    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "openrouter") {
      await setOpenrouterApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    if (!hasCredential) {
      const envKey = resolveEnvApiKey("openrouter");
      if (envKey) {
        const useExisting = await params.prompter.confirm({
          message: `Use existing OPENROUTER_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
          initialValue: true,
        });
        if (useExisting) {
          await setOpenrouterApiKey(envKey.apiKey, params.agentDir);
          hasCredential = true;
        }
      }
    }

    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter OpenRouter API key",
        validate: validateApiKeyInput,
      });
      await setOpenrouterApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
      hasCredential = true;
    }

    if (hasCredential) {
      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId,
        provider: "openrouter",
        mode,
      });
    }
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
        applyDefaultConfig: applyOpenrouterConfig,
        applyProviderConfig: applyOpenrouterProviderConfig,
        noteDefault: OPENROUTER_DEFAULT_MODEL_REF,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "ai-gateway-api-key") {
    let hasCredential = false;

    if (
      !hasCredential &&
      params.opts?.token &&
      params.opts?.tokenProvider === "vercel-ai-gateway"
    ) {
      await setVercelAiGatewayApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    const envKey = resolveEnvApiKey("vercel-ai-gateway");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing AI_GATEWAY_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setVercelAiGatewayApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Vercel AI Gateway API key",
        validate: validateApiKeyInput,
      });
      await setVercelAiGatewayApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "vercel-ai-gateway:default",
      provider: "vercel-ai-gateway",
      mode: "api_key",
    });
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
        applyDefaultConfig: applyVercelAiGatewayConfig,
        applyProviderConfig: applyVercelAiGatewayProviderConfig,
        noteDefault: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "cloudflare-ai-gateway-api-key") {
    let hasCredential = false;
    let accountId = params.opts?.cloudflareAiGatewayAccountId?.trim() ?? "";
    let gatewayId = params.opts?.cloudflareAiGatewayGatewayId?.trim() ?? "";

    const ensureAccountGateway = async () => {
      if (!accountId) {
        const value = await params.prompter.text({
          message: "Enter Cloudflare Account ID",
          validate: (val) => (String(val).trim() ? undefined : "Account ID is required"),
        });
        accountId = String(value).trim();
      }
      if (!gatewayId) {
        const value = await params.prompter.text({
          message: "Enter Cloudflare AI Gateway ID",
          validate: (val) => (String(val).trim() ? undefined : "Gateway ID is required"),
        });
        gatewayId = String(value).trim();
      }
    };

    const optsApiKey = normalizeApiKeyInput(params.opts?.cloudflareAiGatewayApiKey ?? "");
    if (!hasCredential && accountId && gatewayId && optsApiKey) {
      await setCloudflareAiGatewayConfig(accountId, gatewayId, optsApiKey, params.agentDir);
      hasCredential = true;
    }

    const envKey = resolveEnvApiKey("cloudflare-ai-gateway");
    if (!hasCredential && envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing CLOUDFLARE_AI_GATEWAY_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await ensureAccountGateway();
        await setCloudflareAiGatewayConfig(
          accountId,
          gatewayId,
          normalizeApiKeyInput(envKey.apiKey),
          params.agentDir,
        );
        hasCredential = true;
      }
    }

    if (!hasCredential && optsApiKey) {
      await ensureAccountGateway();
      await setCloudflareAiGatewayConfig(accountId, gatewayId, optsApiKey, params.agentDir);
      hasCredential = true;
    }

    if (!hasCredential) {
      await ensureAccountGateway();
      const key = await params.prompter.text({
        message: "Enter Cloudflare AI Gateway API key",
        validate: validateApiKeyInput,
      });
      await setCloudflareAiGatewayConfig(
        accountId,
        gatewayId,
        normalizeApiKeyInput(String(key)),
        params.agentDir,
      );
      hasCredential = true;
    }

    if (hasCredential) {
      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId: "cloudflare-ai-gateway:default",
        provider: "cloudflare-ai-gateway",
        mode: "api_key",
      });
    }
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
        applyDefaultConfig: (cfg) =>
          applyCloudflareAiGatewayConfig(cfg, {
            accountId: accountId || params.opts?.cloudflareAiGatewayAccountId,
            gatewayId: gatewayId || params.opts?.cloudflareAiGatewayGatewayId,
          }),
        applyProviderConfig: (cfg) =>
          applyCloudflareAiGatewayProviderConfig(cfg, {
            accountId: accountId || params.opts?.cloudflareAiGatewayAccountId,
            gatewayId: gatewayId || params.opts?.cloudflareAiGatewayGatewayId,
          }),
        noteDefault: CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "moonshot-api-key") {
    let hasCredential = false;

    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "moonshot") {
      await setMoonshotApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    const envKey = resolveEnvApiKey("moonshot");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing MOONSHOT_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setMoonshotApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Moonshot API key",
        validate: validateApiKeyInput,
      });
      await setMoonshotApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "moonshot:default",
      provider: "moonshot",
      mode: "api_key",
    });
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyDefaultConfig: applyMoonshotConfig,
        applyProviderConfig: applyMoonshotProviderConfig,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "moonshot-api-key-cn") {
    let hasCredential = false;

    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "moonshot") {
      await setMoonshotApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    const envKey = resolveEnvApiKey("moonshot");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing MOONSHOT_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setMoonshotApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Moonshot API key (.cn)",
        validate: validateApiKeyInput,
      });
      await setMoonshotApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "moonshot:default",
      provider: "moonshot",
      mode: "api_key",
    });
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: MOONSHOT_DEFAULT_MODEL_REF,
        applyDefaultConfig: applyMoonshotConfigCn,
        applyProviderConfig: applyMoonshotProviderConfigCn,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "kimi-code-api-key") {
    let hasCredential = false;
    const tokenProvider = params.opts?.tokenProvider?.trim().toLowerCase();
    if (
      !hasCredential &&
      params.opts?.token &&
      (tokenProvider === "kimi-code" || tokenProvider === "kimi-coding")
    ) {
      await setKimiCodingApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    if (!hasCredential) {
      await params.prompter.note(
        [
          "Kimi Coding uses a dedicated endpoint and API key.",
          "Get your API key at: https://www.kimi.com/code/en",
        ].join("\n"),
        "Kimi Coding",
      );
    }
    const envKey = resolveEnvApiKey("kimi-coding");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing KIMI_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setKimiCodingApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Kimi Coding API key",
        validate: validateApiKeyInput,
      });
      await setKimiCodingApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "kimi-coding:default",
      provider: "kimi-coding",
      mode: "api_key",
    });
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: KIMI_CODING_MODEL_REF,
        applyDefaultConfig: applyKimiCodeConfig,
        applyProviderConfig: applyKimiCodeProviderConfig,
        noteDefault: KIMI_CODING_MODEL_REF,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "gemini-api-key") {
    let hasCredential = false;

    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "google") {
      await setGeminiApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    const envKey = resolveEnvApiKey("google");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing GEMINI_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setGeminiApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Gemini API key",
        validate: validateApiKeyInput,
      });
      await setGeminiApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "google:default",
      provider: "google",
      mode: "api_key",
    });
    if (params.setDefaultModel) {
      const applied = applyGoogleGeminiModelDefault(nextConfig);
      nextConfig = applied.next;
      if (applied.changed) {
        await params.prompter.note(
          `Default model set to ${GOOGLE_GEMINI_DEFAULT_MODEL}`,
          "Model configured",
        );
      }
    } else {
      agentModelOverride = GOOGLE_GEMINI_DEFAULT_MODEL;
      await noteAgentModel(GOOGLE_GEMINI_DEFAULT_MODEL);
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "zai-api-key") {
    let hasCredential = false;

    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "zai") {
      await setZaiApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    const envKey = resolveEnvApiKey("zai");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing ZAI_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setZaiApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Z.AI API key",
        validate: validateApiKeyInput,
      });
      await setZaiApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "zai:default",
      provider: "zai",
      mode: "api_key",
    });
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: ZAI_DEFAULT_MODEL_REF,
        applyDefaultConfig: applyZaiConfig,
        applyProviderConfig: (config) => ({
          ...config,
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              models: {
                ...config.agents?.defaults?.models,
                [ZAI_DEFAULT_MODEL_REF]: {
                  ...config.agents?.defaults?.models?.[ZAI_DEFAULT_MODEL_REF],
                  alias: config.agents?.defaults?.models?.[ZAI_DEFAULT_MODEL_REF]?.alias ?? "GLM",
                },
              },
            },
          },
        }),
        noteDefault: ZAI_DEFAULT_MODEL_REF,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "xiaomi-api-key") {
    let hasCredential = false;

    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "xiaomi") {
      await setXiaomiApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    const envKey = resolveEnvApiKey("xiaomi");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing XIAOMI_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setXiaomiApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Xiaomi API key",
        validate: validateApiKeyInput,
      });
      await setXiaomiApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "xiaomi:default",
      provider: "xiaomi",
      mode: "api_key",
    });
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: XIAOMI_DEFAULT_MODEL_REF,
        applyDefaultConfig: applyXiaomiConfig,
        applyProviderConfig: applyXiaomiProviderConfig,
        noteDefault: XIAOMI_DEFAULT_MODEL_REF,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "synthetic-api-key") {
    if (params.opts?.token && params.opts?.tokenProvider === "synthetic") {
      await setSyntheticApiKey(String(params.opts.token).trim(), params.agentDir);
    } else {
      const key = await params.prompter.text({
        message: "Enter Synthetic API key",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      });
      await setSyntheticApiKey(String(key).trim(), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "synthetic:default",
      provider: "synthetic",
      mode: "api_key",
    });
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: SYNTHETIC_DEFAULT_MODEL_REF,
        applyDefaultConfig: applySyntheticConfig,
        applyProviderConfig: applySyntheticProviderConfig,
        noteDefault: SYNTHETIC_DEFAULT_MODEL_REF,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "venice-api-key") {
    let hasCredential = false;

    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "venice") {
      await setVeniceApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    if (!hasCredential) {
      await params.prompter.note(
        [
          "Venice AI provides privacy-focused inference with uncensored models.",
          "Get your API key at: https://venice.ai/settings/api",
          "Supports 'private' (fully private) and 'anonymized' (proxy) modes.",
        ].join("\n"),
        "Venice AI",
      );
    }

    const envKey = resolveEnvApiKey("venice");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing VENICE_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setVeniceApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Venice AI API key",
        validate: validateApiKeyInput,
      });
      await setVeniceApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "venice:default",
      provider: "venice",
      mode: "api_key",
    });
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: VENICE_DEFAULT_MODEL_REF,
        applyDefaultConfig: applyVeniceConfig,
        applyProviderConfig: applyVeniceProviderConfig,
        noteDefault: VENICE_DEFAULT_MODEL_REF,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "opencode-zen") {
    let hasCredential = false;
    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "opencode") {
      await setOpencodeZenApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    if (!hasCredential) {
      await params.prompter.note(
        [
          "OpenCode Zen provides access to Claude, GPT, Gemini, and more models.",
          "Get your API key at: https://opencode.ai/auth",
          "Requires an active OpenCode Zen subscription.",
        ].join("\n"),
        "OpenCode Zen",
      );
    }
    const envKey = resolveEnvApiKey("opencode");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing OPENCODE_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setOpencodeZenApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter OpenCode Zen API key",
        validate: validateApiKeyInput,
      });
      await setOpencodeZenApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "opencode:default",
      provider: "opencode",
      mode: "api_key",
    });
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: OPENCODE_ZEN_DEFAULT_MODEL,
        applyDefaultConfig: applyOpencodeZenConfig,
        applyProviderConfig: applyOpencodeZenProviderConfig,
        noteDefault: OPENCODE_ZEN_DEFAULT_MODEL,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "azure-openai") {
    // Check if Azure CLI is available
    let hasAzureCLI = false;
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      await execAsync("az account show", { timeout: 5000 });
      hasAzureCLI = true;
    } catch {
      hasAzureCLI = false;
    }

    // Ask which Azure service
    const serviceType = await params.prompter.select({
      message: "Which Azure AI service?",
      options: [
        {
          value: "openai",
          label: "Azure OpenAI",
          hint: "GPT-4, text-embedding-3-large, etc.",
        },
        {
          value: "foundry",
          label: "Azure AI Foundry (Model-as-a-Service)",
          hint: "Claude, Llama, Mistral, etc.",
        },
      ],
    });

    if (serviceType === "openai") {
      // Azure OpenAI flow
      let endpoint: string;

      if (hasAzureCLI) {
        // Try auto-discovery first
        const useDiscovery = await params.prompter.confirm({
          message: "Auto-discover Azure OpenAI resources using Azure CLI?",
          initialValue: true,
        });

        if (useDiscovery) {
          const progress = params.prompter.progress("Discovering Azure OpenAI resources…");

          try {
            const { listAzureOpenAIResources } = await import("../agents/azure-discovery.js");
            const resources = await listAzureOpenAIResources();

            progress.stop(`Found ${resources.length} resource${resources.length === 1 ? "" : "s"}`);

            if (resources.length === 0) {
              await params.prompter.note(
                "No Azure OpenAI or AI Services resources found in your subscription.",
                "Manual setup required",
              );
              endpoint = String(
                await params.prompter.text({
                  message: "Enter Azure OpenAI endpoint",
                  placeholder: "https://YOUR-RESOURCE.openai.azure.com",
                  validate: (input) => {
                    const value = String(input).trim();
                    if (!value) return "Endpoint is required";
                    if (!value.startsWith("https://")) return "Endpoint must start with https://";
                    return undefined;
                  },
                }),
              ).trim();
            } else if (resources.length === 1) {
              endpoint = resources[0].endpoint;
              await params.prompter.note(
                `Using: ${resources[0].name}\nEndpoint: ${endpoint}`,
                "Azure OpenAI resource",
              );
            } else {
              const selected = await params.prompter.select({
                message: "Select Azure OpenAI resource",
                options: resources.map((r) => ({
                  value: r.endpoint,
                  label: r.name,
                  hint: `${r.kind} in ${r.location}`,
                })),
              });
              endpoint = String(selected);
            }
          } catch (error) {
            progress.stop("Discovery failed");
            await params.prompter.note(
              `Could not discover resources: ${error instanceof Error ? error.message : String(error)}`,
              "Warning",
            );
            endpoint = String(
              await params.prompter.text({
                message: "Enter Azure OpenAI endpoint",
                placeholder: "https://YOUR-RESOURCE.openai.azure.com",
                validate: (input) => {
                  const value = String(input).trim();
                  if (!value) return "Endpoint is required";
                  if (!value.startsWith("https://")) return "Endpoint must start with https://";
                  return undefined;
                },
              }),
            ).trim();
          }
        } else {
          endpoint = String(
            await params.prompter.text({
              message: "Enter Azure OpenAI endpoint",
              placeholder: "https://YOUR-RESOURCE.openai.azure.com",
              validate: (input) => {
                const value = String(input).trim();
                if (!value) return "Endpoint is required";
                if (!value.startsWith("https://")) return "Endpoint must start with https://";
                return undefined;
              },
            }),
          ).trim();
        }
      } else {
        endpoint = String(
          await params.prompter.text({
            message: "Enter Azure OpenAI endpoint",
            placeholder: "https://YOUR-RESOURCE.openai.azure.com",
            validate: (input) => {
              const value = String(input).trim();
              if (!value) return "Endpoint is required";
              if (!value.startsWith("https://")) return "Endpoint must start with https://";
              return undefined;
            },
          }),
        ).trim();
      }

      // Configure Azure OpenAI with discovery
      nextConfig = await applyAzureOpenAiProviderConfig({
        config: nextConfig,
        endpoint,
      });

      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId: "azure-openai:default",
        provider: "azure-openai",
        mode: hasAzureCLI ? "azure-cli" : "api_key",
      });

      const modelRef = "azure-openai/gpt-4";
      if (params.setDefaultModel) {
        await params.prompter.note(`Set default model to ${modelRef}`, "Model configured");
        nextConfig = {
          ...nextConfig,
          agents: {
            ...nextConfig.agents,
            defaults: {
              ...nextConfig.agents?.defaults,
              model: modelRef,
            },
          },
        };
      } else if (params.agentId) {
        await noteAgentModel(modelRef);
        agentModelOverride = modelRef;
      }

      return { config: nextConfig, agentModelOverride };
    }

    if (serviceType === "foundry") {
      // Azure Foundry - discover projects and deployments
      let endpoint: string;

      if (hasAzureCLI) {
        const useDiscovery = await params.prompter.confirm({
          message: "Auto-discover Azure AI Foundry projects using Azure CLI?",
          initialValue: true,
        });

        if (useDiscovery) {
          const progress = params.prompter.progress("Discovering Azure AI Foundry projects…");

          try {
            const { listAzureAIProjects } = await import("../agents/azure-discovery.js");
            const projects = await listAzureAIProjects();

            progress.stop(`Found ${projects.length} project${projects.length === 1 ? "" : "s"}`);

            if (projects.length === 0) {
              await params.prompter.note(
                "No Azure AI Foundry projects found in your subscription.",
                "Manual setup required",
              );
              endpoint = String(
                await params.prompter.text({
                  message: "Enter Azure AI Foundry endpoint",
                  placeholder: "https://YOUR-PROJECT.services.ai.azure.com",
                  validate: (input) => {
                    const value = String(input).trim();
                    if (!value) return "Endpoint is required";
                    if (!value.startsWith("https://")) return "Endpoint must start with https://";
                    if (!value.includes("services.ai.azure.com"))
                      return "Must be an Azure AI Foundry endpoint";
                    return undefined;
                  },
                }),
              ).trim();
            } else if (projects.length === 1) {
              const project = projects[0];
              const projectType = project.kind || "Standard workspace";
              await params.prompter.note(
                `Project: ${project.name}\nLocation: ${project.location}\nType: ${projectType}`,
                "Azure AI Foundry project",
              );
              // Construct endpoint from project name
              endpoint = `https://${project.name}.services.ai.azure.com`;
            } else {
              const selected = await params.prompter.select({
                message: "Select Azure AI Foundry project",
                options: projects.map((p) => {
                  const projectType = p.kind || "Workspace";
                  const sku = p.sku ? ` [${p.sku}]` : "";
                  return {
                    value: p.name,
                    label: p.name,
                    hint: `${p.location} - ${projectType}${sku}`,
                  };
                }),
              });
              endpoint = `https://${String(selected)}.services.ai.azure.com`;
            }
          } catch (error) {
            progress.stop("Discovery failed");
            await params.prompter.note(
              `Could not discover projects: ${error instanceof Error ? error.message : String(error)}`,
              "Warning",
            );
            endpoint = String(
              await params.prompter.text({
                message: "Enter Azure AI Foundry endpoint",
                placeholder: "https://YOUR-PROJECT.services.ai.azure.com",
                validate: (input) => {
                  const value = String(input).trim();
                  if (!value) return "Endpoint is required";
                  if (!value.startsWith("https://")) return "Endpoint must start with https://";
                  if (!value.includes("services.ai.azure.com"))
                    return "Must be an Azure AI Foundry endpoint";
                  return undefined;
                },
              }),
            ).trim();
          }
        } else {
          endpoint = String(
            await params.prompter.text({
              message: "Enter Azure AI Foundry endpoint",
              placeholder: "https://YOUR-PROJECT.services.ai.azure.com",
              validate: (input) => {
                const value = String(input).trim();
                if (!value) return "Endpoint is required";
                if (!value.startsWith("https://")) return "Endpoint must start with https://";
                if (!value.includes("services.ai.azure.com"))
                  return "Must be an Azure AI Foundry endpoint";
                return undefined;
              },
            }),
          ).trim();
        }
      } else {
        endpoint = String(
          await params.prompter.text({
            message: "Enter Azure AI Foundry endpoint",
            placeholder: "https://YOUR-PROJECT.services.ai.azure.com",
            validate: (input) => {
              const value = String(input).trim();
              if (!value) return "Endpoint is required";
              if (!value.startsWith("https://")) return "Endpoint must start with https://";
              if (!value.includes("services.ai.azure.com"))
                return "Must be an Azure AI Foundry endpoint";
              return undefined;
            },
          }),
        ).trim();
      }

      const endpointStr = endpoint;

      // Discover deployed models
      const progress = params.prompter.progress(
        "Discovering deployed models (trying multiple API versions)…",
      );

      let deployments: Array<{
        name: string;
        model: string;
        api?: string;
        publisher?: string;
        isEmbedding?: boolean;
      }> = [];

      try {
        const { listAzureFoundryDeployments } = await import("../agents/azure-discovery.js");
        const apiKey = process.env.AZURE_FOUNDRY_API_KEY ?? null;
        const rawDeployments = await listAzureFoundryDeployments(endpointStr, apiKey);

        if (rawDeployments.length === 0) {
          progress.stop("No deployments found");
          await params.prompter.note(
            [
              "No model deployments found via API.",
              "",
              "This can happen if:",
              "- Models are deployed but not in the expected format",
              "- The endpoint requires a different API version",
              "- The resource uses a deployment-specific path",
              "",
              "You can manually specify the deployment details.",
            ].join("\n"),
            "Manual Configuration",
          );
        } else {
          deployments = rawDeployments
            .filter((d) => {
              const state = d.properties?.provisioningState?.toLowerCase();
              return !state || state === "succeeded";
            })
            .map((d) => {
              const modelName = d.model.name.toLowerCase();
              const isEmbedding = modelName.includes("embed");
              return {
                name: d.name,
                model: d.model.name,
                api: d.api,
                publisher: d.model.publisher,
                isEmbedding,
              };
            });

          const chatCount = deployments.filter((d) => !d.isEmbedding).length;
          const embedCount = deployments.filter((d) => d.isEmbedding).length;
          progress.stop(
            `Found ${deployments.length} model${deployments.length === 1 ? "" : "s"} (${chatCount} chat, ${embedCount} embeddings)`,
          );
        }
      } catch (error) {
        progress.stop("Could not discover deployments");
        await params.prompter.note(
          [
            `Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
            "",
            "Common causes:",
            "- Wrong API endpoint format",
            "- Missing permissions",
            "- Resource not fully provisioned",
            "",
            "You can configure manually below.",
          ].join("\n"),
          "Warning",
        );
      }

      // Separate chat and embedding models
      const chatModels = deployments.filter((d) => !d.isEmbedding);
      const embeddingModels = deployments.filter((d) => d.isEmbedding);

      let chatModelId: string;
      let chatApiType: string;

      // Select chat model
      if (chatModels.length === 0) {
        await params.prompter.note("No chat models found. Please enter manually.", "Manual setup");

        chatApiType = String(
          await params.prompter.select({
            message: "Which chat model API type?",
            options: [
              { value: "anthropic-messages", label: "Anthropic (Claude)" },
              { value: "openai-completions", label: "OpenAI-compatible (GPT, Llama, Mistral)" },
            ],
          }),
        );

        chatModelId = String(
          await params.prompter.text({
            message: "Enter chat model deployment name",
            placeholder: "claude-opus-4-5",
          }),
        ).trim();
      } else {
        const deployment = await params.prompter.select({
          message: `Select chat model (${chatModels.length} available)`,
          options: chatModels.map((d) => {
            const modelInfo = d.model;
            const publisher = d.publisher ? ` by ${d.publisher}` : "";
            const apiHint = d.api || "unknown API";
            return {
              value: d.name,
              label: `${d.name} - ${modelInfo}${publisher}`,
              hint: apiHint,
            };
          }),
        });

        const selectedDeployment = chatModels.find((d) => d.name === deployment);
        if (!selectedDeployment) {
          throw new Error(`Deployment ${String(deployment)} not found`);
        }

        chatModelId = selectedDeployment.name;

        // Infer API type from publisher/model
        if (
          selectedDeployment.publisher === "anthropic" ||
          selectedDeployment.model.toLowerCase().includes("claude")
        ) {
          chatApiType = "anthropic-messages";
        } else {
          chatApiType = "openai-completions";
        }

        await params.prompter.note(
          `Chat API: ${chatApiType === "anthropic-messages" ? "Anthropic" : "OpenAI-compatible"}`,
          "Detected",
        );
      }

      // Ask about embeddings configuration
      const configureEmbeddings = await params.prompter.confirm({
        message: "Configure embeddings model for memory search?",
        initialValue: embeddingModels.length > 0,
      });

      let embeddingModelId: string | undefined;
      let embeddingApiType: string | undefined;

      if (configureEmbeddings) {
        if (embeddingModels.length === 0) {
          await params.prompter.note(
            "No embedding models found. Enter manually or skip.",
            "Manual setup",
          );

          const embedModelName = await params.prompter.text({
            message: "Enter embeddings model deployment name (or leave empty to skip)",
            placeholder: "text-embedding-3-large",
            defaultValue: "",
          });

          if (String(embedModelName).trim()) {
            embeddingModelId = String(embedModelName).trim();
            embeddingApiType = "openai-completions";
          }
        } else {
          const embedOptions = [
            ...embeddingModels.map((d) => {
              const modelInfo = d.model;
              const publisher = d.publisher ? ` by ${d.publisher}` : "";
              const apiHint = d.api || "openai-completions";
              return {
                value: d.name,
                label: `${d.name} - ${modelInfo}${publisher}`,
                hint: apiHint,
              };
            }),
            { value: "__skip__", label: "Skip embeddings configuration", hint: "Configure later" },
          ];

          const selectedEmbed = await params.prompter.select({
            message: `Select embeddings model (${embeddingModels.length} available)`,
            options: embedOptions,
          });

          if (selectedEmbed !== "__skip__") {
            const selectedDeployment = embeddingModels.find((d) => d.name === selectedEmbed);
            if (selectedDeployment) {
              embeddingModelId = selectedDeployment.name;
              embeddingApiType = "openai-completions";
              await params.prompter.note(`Embeddings: ${embeddingModelId}`, "Configured");
            }
          }
        }
      }

      // Create provider config for chat
      const chatProviderName = "azure-foundry";
      nextConfig = {
        ...nextConfig,
        models: {
          ...nextConfig.models,
          providers: {
            ...nextConfig.models?.providers,
            [chatProviderName]: {
              baseUrl: endpointStr,
              api: chatApiType as any,
              models: [],
            },
          },
        },
      };

      nextConfig = applyAuthProfileConfig(nextConfig, {
        profileId: `${chatProviderName}:default`,
        provider: chatProviderName,
        mode: hasAzureCLI ? "azure-cli" : "api_key",
      });

      const chatModelRef = `${chatProviderName}/${chatModelId}`;

      // Configure embeddings if selected
      if (embeddingModelId && embeddingApiType) {
        const embedProviderName = "azure-foundry-embeddings";
        nextConfig = {
          ...nextConfig,
          models: {
            ...nextConfig.models,
            providers: {
              ...nextConfig.models?.providers,
              [embedProviderName]: {
                baseUrl: endpointStr,
                api: embeddingApiType as any,
                models: [],
              },
            },
          },
        };

        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId: `${embedProviderName}:default`,
          provider: embedProviderName,
          mode: hasAzureCLI ? "azure-cli" : "api_key",
        });

        // Configure memory search to use Azure embeddings
        nextConfig = {
          ...nextConfig,
          tools: {
            ...nextConfig.tools,
            memorySearch: {
              ...nextConfig.tools?.memorySearch,
              enabled: true,
              provider: embedProviderName,
              model: embeddingModelId,
            },
          },
        };

        await params.prompter.note(
          `Chat: ${chatModelRef}\nEmbeddings: ${embedProviderName}/${embeddingModelId}`,
          "Models configured",
        );
      } else {
        await params.prompter.note(`Chat: ${chatModelRef}`, "Model configured");
      }

      if (params.setDefaultModel) {
        nextConfig = {
          ...nextConfig,
          agents: {
            ...nextConfig.agents,
            defaults: {
              ...nextConfig.agents?.defaults,
              model: chatModelRef,
            },
          },
        };
      } else if (params.agentId) {
        await noteAgentModel(chatModelRef);
        agentModelOverride = chatModelRef;
      }

      return { config: nextConfig, agentModelOverride };
    }
  }

  return null;
}
