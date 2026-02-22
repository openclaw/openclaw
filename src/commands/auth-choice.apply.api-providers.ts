import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import {
  formatApiKeyPreview,
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "./auth-choice.api-key.js";
import { createAuthChoiceAgentModelNoter } from "./auth-choice.apply-helpers.js";
import { applyAuthChoiceHuggingface } from "./auth-choice.apply.huggingface.js";
import { applyAuthChoiceOpenRouter } from "./auth-choice.apply.openrouter.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
import {
  applyGoogleGeminiModelDefault,
  GOOGLE_GEMINI_DEFAULT_MODEL,
} from "./google-gemini-model-default.js";
import {
  applyAuthProfileConfig,
  applyCloudflareAiGatewayConfig,
  applyCloudflareAiGatewayProviderConfig,
  applyQianfanConfig,
  applyQianfanProviderConfig,
  applyKimiCodeConfig,
  applyKimiCodeProviderConfig,
  applyLitellmConfig,
  applyLitellmProviderConfig,
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  applyMoonshotProviderConfig,
  applyMoonshotProviderConfigCn,
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
  applySyntheticConfig,
  applySyntheticProviderConfig,
  applyTogetherConfig,
  applyTogetherProviderConfig,
  applyVeniceConfig,
  applyVeniceProviderConfig,
  applyVercelAiGatewayConfig,
  applyVercelAiGatewayProviderConfig,
  applyXiaomiConfig,
  applyXiaomiProviderConfig,
  applyZaiConfig,
  applyZaiProviderConfig,
  CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF,
  QIANFAN_DEFAULT_MODEL_REF,
  KIMI_CODING_MODEL_REF,
  MOONSHOT_DEFAULT_MODEL_REF,
  SYNTHETIC_DEFAULT_MODEL_REF,
  TOGETHER_DEFAULT_MODEL_REF,
  VENICE_DEFAULT_MODEL_REF,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  XIAOMI_DEFAULT_MODEL_REF,
  setCloudflareAiGatewayConfig,
  setQianfanApiKey,
  setGeminiApiKey,
  setLitellmApiKey,
  setKimiCodingApiKey,
  setMoonshotApiKey,
  setOpencodeZenApiKey,
  setSyntheticApiKey,
  setTogetherApiKey,
  setVeniceApiKey,
  setVercelAiGatewayApiKey,
  setXiaomiApiKey,
  setZaiApiKey,
  ZAI_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";
import { OPENCODE_ZEN_DEFAULT_MODEL } from "./opencode-zen-model-default.js";
import { detectZaiEndpoint } from "./zai-endpoint-detect.js";

export async function applyAuthChoiceApiProviders(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  let nextConfig = params.config;
  let agentModelOverride: string | undefined;
  const noteAgentModel = createAuthChoiceAgentModelNoter(params);

  let authChoice = params.authChoice;
  if (
    authChoice === "apiKey" &&
    params.opts?.tokenProvider &&
    params.opts.tokenProvider !== "anthropic" &&
    params.opts.tokenProvider !== "openai"
  ) {
    if (params.opts.tokenProvider === "openrouter") {
      authChoice = "openrouter-api-key";
    } else if (params.opts.tokenProvider === "litellm") {
      authChoice = "litellm-api-key";
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
    } else if (params.opts.tokenProvider === "together") {
      authChoice = "together-api-key";
    } else if (params.opts.tokenProvider === "huggingface") {
      authChoice = "huggingface-api-key";
    } else if (params.opts.tokenProvider === "opencode") {
      authChoice = "opencode-zen";
    } else if (params.opts.tokenProvider === "qianfan") {
      authChoice = "qianfan-api-key";
    }
  }

  async function ensureMoonshotApiKeyCredential(promptMessage: string): Promise<void> {
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
        message: promptMessage,
        validate: validateApiKeyInput,
      });
      await setMoonshotApiKey(normalizeApiKeyInput(String(key ?? "")), params.agentDir);
    }
  }

  if (authChoice === "openrouter-api-key") {
    return applyAuthChoiceOpenRouter(params);
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
      await setVercelAiGatewayApiKey(normalizeApiKeyInput(String(key ?? "")), params.agentDir);
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
          validate: (val) => (String(val ?? "").trim() ? undefined : "Account ID is required"),
        });
        accountId = String(value ?? "").trim();
      }
      if (!gatewayId) {
        const value = await params.prompter.text({
          message: "Enter Cloudflare AI Gateway ID",
          validate: (val) => (String(val ?? "").trim() ? undefined : "Gateway ID is required"),
        });
        gatewayId = String(value ?? "").trim();
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
        normalizeApiKeyInput(String(key ?? "")),
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
    await ensureMoonshotApiKeyCredential("Enter Moonshot API key");
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
    await ensureMoonshotApiKeyCredential("Enter Moonshot API key (.cn)");
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
      await setKimiCodingApiKey(normalizeApiKeyInput(String(key ?? "")), params.agentDir);
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
      await setGeminiApiKey(normalizeApiKeyInput(String(key ?? "")), params.agentDir);
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

  if (
    authChoice === "zai-api-key" ||
    authChoice === "zai-coding-global" ||
    authChoice === "zai-coding-cn" ||
    authChoice === "zai-global" ||
    authChoice === "zai-cn"
  ) {
    let endpoint: "global" | "cn" | "coding-global" | "coding-cn" | undefined;
    if (authChoice === "zai-coding-global") {
      endpoint = "coding-global";
    } else if (authChoice === "zai-coding-cn") {
      endpoint = "coding-cn";
    } else if (authChoice === "zai-global") {
      endpoint = "global";
    } else if (authChoice === "zai-cn") {
      endpoint = "cn";
    }

    // Input API key
    let hasCredential = false;
    let apiKey = "";

    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "zai") {
      apiKey = normalizeApiKeyInput(params.opts.token);
      await setZaiApiKey(apiKey, params.agentDir);
      hasCredential = true;
    }

    const envKey = resolveEnvApiKey("zai");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing ZAI_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        apiKey = envKey.apiKey;
        await setZaiApiKey(apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Z.AI API key",
        validate: validateApiKeyInput,
      });
      apiKey = normalizeApiKeyInput(String(key ?? ""));
      await setZaiApiKey(apiKey, params.agentDir);
    }

    // zai-api-key: auto-detect endpoint + choose a working default model.
    let modelIdOverride: string | undefined;
    if (!endpoint) {
      const detected = await detectZaiEndpoint({ apiKey });
      if (detected) {
        endpoint = detected.endpoint;
        modelIdOverride = detected.modelId;
        await params.prompter.note(detected.note, "Z.AI endpoint");
      } else {
        endpoint = await params.prompter.select({
          message: "Select Z.AI endpoint",
          options: [
            {
              value: "coding-global",
              label: "Coding-Plan-Global",
              hint: "GLM Coding Plan Global (api.z.ai)",
            },
            {
              value: "coding-cn",
              label: "Coding-Plan-CN",
              hint: "GLM Coding Plan CN (open.bigmodel.cn)",
            },
            {
              value: "global",
              label: "Global",
              hint: "Z.AI Global (api.z.ai)",
            },
            {
              value: "cn",
              label: "CN",
              hint: "Z.AI CN (open.bigmodel.cn)",
            },
          ],
          initialValue: "global",
        });
      }
    }

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "zai:default",
      provider: "zai",
      mode: "api_key",
    });

    const defaultModel = modelIdOverride ? `zai/${modelIdOverride}` : ZAI_DEFAULT_MODEL_REF;
    const applied = await applyDefaultModelChoice({
      config: nextConfig,
      setDefaultModel: params.setDefaultModel,
      defaultModel,
      applyDefaultConfig: (config) =>
        applyZaiConfig(config, {
          endpoint,
          ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
        }),
      applyProviderConfig: (config) =>
        applyZaiProviderConfig(config, {
          endpoint,
          ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
        }),
      noteDefault: defaultModel,
      noteAgentModel,
      prompter: params.prompter,
    });
    nextConfig = applied.config;
    agentModelOverride = applied.agentModelOverride ?? agentModelOverride;

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
      await setXiaomiApiKey(normalizeApiKeyInput(String(key ?? "")), params.agentDir);
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
      await setSyntheticApiKey(String(params.opts.token ?? "").trim(), params.agentDir);
    } else {
      const key = await params.prompter.text({
        message: "Enter Synthetic API key",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      });
      await setSyntheticApiKey(String(key ?? "").trim(), params.agentDir);
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
      await setVeniceApiKey(normalizeApiKeyInput(String(key ?? "")), params.agentDir);
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
          "OpenCode Zen bills per request. Check your OpenCode dashboard for details.",
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
      await setOpencodeZenApiKey(normalizeApiKeyInput(String(key ?? "")), params.agentDir);
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

  if (authChoice === "together-api-key") {
    let hasCredential = false;

    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "together") {
      await setTogetherApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    if (!hasCredential) {
      await params.prompter.note(
        [
          "Together AI provides access to leading open-source models including Llama, DeepSeek, Qwen, and more.",
          "Get your API key at: https://api.together.xyz/settings/api-keys",
        ].join("\n"),
        "Together AI",
      );
    }

    const envKey = resolveEnvApiKey("together");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing TOGETHER_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setTogetherApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter Together AI API key",
        validate: validateApiKeyInput,
      });
      await setTogetherApiKey(normalizeApiKeyInput(String(key ?? "")), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "together:default",
      provider: "together",
      mode: "api_key",
    });
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: TOGETHER_DEFAULT_MODEL_REF,
        applyDefaultConfig: applyTogetherConfig,
        applyProviderConfig: applyTogetherProviderConfig,
        noteDefault: TOGETHER_DEFAULT_MODEL_REF,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "huggingface-api-key") {
    return applyAuthChoiceHuggingface({ ...params, authChoice });
  }

  if (authChoice === "qianfan-api-key") {
    let hasCredential = false;
    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "qianfan") {
      setQianfanApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
      hasCredential = true;
    }

    if (!hasCredential) {
      await params.prompter.note(
        [
          "Get your API key at: https://console.bce.baidu.com/qianfan/ais/console/apiKey",
          "API key format: bce-v3/ALTAK-...",
        ].join("\n"),
        "QIANFAN",
      );
    }
    const envKey2 = resolveEnvApiKey("qianfan");
    if (envKey2) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing QIANFAN_API_KEY (${envKey2.source}, ${formatApiKeyPreview(envKey2.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        setQianfanApiKey(envKey2.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter QIANFAN API key",
        validate: validateApiKeyInput,
      });
      setQianfanApiKey(normalizeApiKeyInput(String(key ?? "")), params.agentDir);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "qianfan:default",
      provider: "qianfan",
      mode: "api_key",
    });
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: QIANFAN_DEFAULT_MODEL_REF,
        applyDefaultConfig: applyQianfanConfig,
        applyProviderConfig: applyQianfanProviderConfig,
        noteDefault: QIANFAN_DEFAULT_MODEL_REF,
        noteAgentModel,
        prompter: params.prompter,
      });
      nextConfig = applied.config;
      agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
    }
    return { config: nextConfig, agentModelOverride };
  }

  if (authChoice === "litellm-api-key") {
    let hasCredential = false;
    let apiKey: string | undefined;

    // Check for pre-provided API key via CLI options (--litellm-api-key or --token with --token-provider litellm)
    if (!hasCredential && params.opts?.litellmApiKey) {
      apiKey = normalizeApiKeyInput(params.opts.litellmApiKey);
      await setLitellmApiKey(apiKey, params.agentDir);
      hasCredential = true;
    }
    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "litellm") {
      apiKey = normalizeApiKeyInput(params.opts.token);
      await setLitellmApiKey(apiKey, params.agentDir);
      hasCredential = true;
    }

    if (!hasCredential) {
      await params.prompter.note(
        [
          "LiteLLM is an OpenAI-compatible proxy that supports many models.",
          "You'll need to provide:",
          "  1. Base URL (e.g., http://localhost:4000)",
          "  2. API key",
          "  3. Model selection (fetched from your LiteLLM instance)",
        ].join("\n"),
        "LiteLLM",
      );
    }

    // Check for existing env key
    const envKey = resolveEnvApiKey("litellm");
    if (!hasCredential && envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing LITELLM_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        apiKey = envKey.apiKey;
        await setLitellmApiKey(apiKey, params.agentDir);
        hasCredential = true;
      }
    }

    // Helper function to prompt for API key
    const promptForApiKey = async () => {
      const key = await params.prompter.text({
        message: "Enter LiteLLM API key",
        validate: validateApiKeyInput,
      });
      return normalizeApiKeyInput(String(key));
    };

    // Helper function to prompt for base URL
    const promptForBaseUrl = async () => {
      const defaultBaseUrl = process.env.LITELLM_BASE_URL ?? "http://localhost:4000";
      const baseUrl = await params.prompter.text({
        message: "Enter LiteLLM base URL",
        initialValue: defaultBaseUrl,
        placeholder: defaultBaseUrl,
        validate: (value) => {
          if (!value?.trim()) {
            return "Base URL is required";
          }
          try {
            new URL(value);
            return undefined;
          } catch {
            return "Invalid URL format";
          }
        },
      });
      return String(baseUrl).trim();
    };

    if (!hasCredential) {
      apiKey = await promptForApiKey();
      await setLitellmApiKey(apiKey, params.agentDir);
    }

    // Check for pre-provided base URL via CLI option (--litellm-base-url)
    let normalizedBaseUrl: string;
    if (params.opts?.litellmBaseUrl) {
      normalizedBaseUrl = params.opts.litellmBaseUrl.trim();
    } else {
      normalizedBaseUrl = await promptForBaseUrl();
    }

    // Re-store credential with base URL metadata for implicit provider discovery
    if (apiKey) {
      await setLitellmApiKey(apiKey, params.agentDir, normalizedBaseUrl);
    }

    // Try to fetch available models from LiteLLM
    type LitellmModelInfo = { id: string; maxInputTokens?: number; maxOutputTokens?: number };
    let availableModels: LitellmModelInfo[] = [];
    const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

    // First fetch model list from /v1/models
    try {
      const base = normalizedBaseUrl.endsWith("/") ? normalizedBaseUrl : `${normalizedBaseUrl}/`;
      const modelsUrl = new URL("v1/models", base).toString();
      const response = await fetch(modelsUrl, {
        headers: authHeaders,
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const data = (await response.json()) as {
          data?: Array<{ id: string }>;
        };
        if (data.data && Array.isArray(data.data)) {
          availableModels = data.data.map((m) => ({ id: m.id }));
        }
      }
    } catch {
      // Fetching models failed - will fall back to manual entry
    }

    // Then fetch detailed model info from /model/info (LiteLLM-specific endpoint)
    // This provides context window and max tokens info
    type ModelInfoEntry = {
      model_name: string;
      model_info?: {
        max_input_tokens?: number;
        max_tokens?: number;
        max_output_tokens?: number;
      };
    };
    const modelInfoMap = new Map<string, { maxInputTokens?: number; maxOutputTokens?: number }>();
    try {
      const infoBase = normalizedBaseUrl.endsWith("/")
        ? normalizedBaseUrl
        : `${normalizedBaseUrl}/`;
      const modelInfoUrl = new URL("model/info", infoBase).toString();
      const response = await fetch(modelInfoUrl, {
        headers: authHeaders,
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const data = (await response.json()) as { data?: ModelInfoEntry[] };
        if (data.data && Array.isArray(data.data)) {
          for (const entry of data.data) {
            if (entry.model_name && entry.model_info) {
              modelInfoMap.set(entry.model_name, {
                maxInputTokens: entry.model_info.max_input_tokens,
                maxOutputTokens: entry.model_info.max_output_tokens ?? entry.model_info.max_tokens,
              });
            }
          }
        }
      }
    } catch {
      // Model info fetch failed - context window will need manual entry
    }

    // Merge model info into available models
    availableModels = availableModels.map((m) => {
      const info = modelInfoMap.get(m.id);
      return {
        id: m.id,
        maxInputTokens: info?.maxInputTokens,
        maxOutputTokens: info?.maxOutputTokens,
      };
    });

    let normalizedModelId: string;
    let contextWindow: number | undefined;
    let maxTokens: number | undefined;

    // Check for pre-provided model via CLI option (--litellm-model)
    if (params.opts?.litellmModel) {
      normalizedModelId = params.opts.litellmModel.trim();
      // Try to get context info from model info map
      const modelInfo = availableModels.find((m) => m.id === normalizedModelId);
      if (modelInfo?.maxInputTokens) {
        contextWindow = modelInfo.maxInputTokens;
      }
      if (modelInfo?.maxOutputTokens) {
        maxTokens = modelInfo.maxOutputTokens;
      }
    } else if (availableModels.length > 0) {
      // Let user select from available models
      type SelectOption = { value: string; label: string; hint?: string };
      const modelOptions: SelectOption[] = availableModels.map((m) => ({
        value: m.id,
        label: m.id,
        hint: m.maxInputTokens ? `${Math.round(m.maxInputTokens / 1000)}k context` : undefined,
      }));

      const selectedModel = await params.prompter.select({
        message: `Select model (${availableModels.length} available)`,
        options: modelOptions,
      });

      normalizedModelId = String(selectedModel);
      const modelInfo = availableModels.find((m) => m.id === normalizedModelId);
      if (modelInfo?.maxInputTokens) {
        contextWindow = modelInfo.maxInputTokens;
      }
      if (modelInfo?.maxOutputTokens) {
        maxTokens = modelInfo.maxOutputTokens;
      }
    } else if (params.opts?.nonInteractive) {
      // In non-interactive mode, fail fast instead of prompting
      throw new Error(
        `LiteLLM model discovery failed: no models found at ${normalizedBaseUrl}. ` +
          `Use --litellm-model to specify a model explicitly.`,
      );
    } else {
      // No models available from LiteLLM - offer manual entry or retry
      await params.prompter.note(
        [
          "Could not fetch models from LiteLLM server.",
          `Server: ${normalizedBaseUrl}`,
          "",
          "This could be due to:",
          "  \u2022 Invalid API key",
          "  \u2022 Server not accessible",
          "  \u2022 Network connectivity issues",
        ].join("\n"),
        "Model fetch failed",
      );

      const action = await params.prompter.select({
        message: "How would you like to proceed?",
        options: [
          { value: "retry-apikey", label: "Re-enter API key" },
          { value: "retry-baseurl", label: "Re-enter base URL" },
          { value: "cancel", label: "Go back to auth method selection" },
        ],
      });

      if (action === "cancel") {
        throw new Error("AUTH_CHOICE_CANCELLED");
      }

      if (action === "retry-apikey") {
        const newParams = {
          ...params,
          authChoice: "litellm-api-key" as const,
          opts: {
            ...params.opts,
            litellmApiKey: undefined,
            token: undefined,
          },
        };
        return await applyAuthChoiceApiProviders(newParams);
      }

      if (action === "retry-baseurl") {
        const newParams = {
          ...params,
          authChoice: "litellm-api-key" as const,
          opts: {
            ...params.opts,
            litellmBaseUrl: undefined,
          },
        };
        return await applyAuthChoiceApiProviders(newParams);
      }

      throw new Error("Failed to configure LiteLLM provider");
    }

    // Strip litellm/ prefix if the API returned it (avoid litellm/litellm/model)
    if (normalizedModelId.startsWith("litellm/")) {
      normalizedModelId = normalizedModelId.slice("litellm/".length);
    }

    const modelRef = `litellm/${normalizedModelId}`;

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "litellm:default",
      provider: "litellm",
      mode: "api_key",
    });

    if (params.setDefaultModel) {
      nextConfig = applyLitellmConfig(nextConfig, {
        baseUrl: normalizedBaseUrl,
        modelId: normalizedModelId,
        contextWindow,
        maxTokens,
      });
      await params.prompter.note(
        `Default model set to ${modelRef}${contextWindow ? ` (${Math.round(contextWindow / 1000)}k context)` : ""}`,
        "Model configured",
      );
    } else {
      nextConfig = applyLitellmProviderConfig(nextConfig, {
        baseUrl: normalizedBaseUrl,
        modelId: normalizedModelId,
        contextWindow,
        maxTokens,
      });
      agentModelOverride = modelRef;
      await noteAgentModel(modelRef);
    }

    return { config: nextConfig, agentModelOverride };
  }

  return null;
}
