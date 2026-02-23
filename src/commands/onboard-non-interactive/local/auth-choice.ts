import { upsertAuthProfile } from "../../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../../agents/model-selection.js";
import { parseDurationMs } from "../../../cli/parse-duration.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { upsertSharedEnvVar } from "../../../infra/env-file.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { shortenHomePath } from "../../../utils.js";
import { normalizeSecretInput } from "../../../utils/normalize-secret-input.js";
import { buildTokenProfileId, validateAnthropicSetupToken } from "../../auth-token.js";
import { applyGoogleGeminiModelDefault } from "../../google-gemini-model-default.js";
import { applyPrimaryModel } from "../../model-picker.js";
import {
  applyAuthProfileConfig,
  applyCloudflareAiGatewayConfig,
  applyKilocodeConfig,
  applyQianfanConfig,
  applyKimiCodeConfig,
  applyMinimaxApiConfig,
  applyMinimaxApiConfigCn,
  applyMinimaxConfig,
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  applyOpencodeZenConfig,
  applyOpenrouterConfig,
  applySyntheticConfig,
  applyVeniceConfig,
  applyTogetherConfig,
  applyHuggingfaceConfig,
  applyVercelAiGatewayConfig,
  applyLitellmConfig,
  applyMistralConfig,
  applyXaiConfig,
  applyXiaomiConfig,
  applyZaiConfig,
  setAnthropicApiKey,
  setCloudflareAiGatewayConfig,
  setQianfanApiKey,
  setGeminiApiKey,
  setKilocodeApiKey,
  setKimiCodingApiKey,
  setLitellmApiKey,
  setMistralApiKey,
  setMinimaxApiKey,
  setMoonshotApiKey,
  setOpencodeZenApiKey,
  setOpenrouterApiKey,
  setSyntheticApiKey,
  setXaiApiKey,
  setVeniceApiKey,
  setTogetherApiKey,
  setHuggingfaceApiKey,
  setVercelAiGatewayApiKey,
  setXiaomiApiKey,
  setZaiApiKey,
} from "../../onboard-auth.js";
import {
  applyCustomApiConfig,
  CustomApiError,
  parseNonInteractiveCustomApiFlags,
  resolveCustomProviderId,
} from "../../onboard-custom.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";
import { applyOpenAIConfig } from "../../openai-model-default.js";
import { detectZaiEndpoint } from "../../zai-endpoint-detect.js";
import { resolveNonInteractiveApiKey } from "../api-keys.js";

export async function applyNonInteractiveAuthChoice(params: {
  nextConfig: OpenClawConfig;
  authChoice: AuthChoice;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
}): Promise<OpenClawConfig | null> {
  const { authChoice, opts, runtime, baseConfig } = params;
  let nextConfig = params.nextConfig;

  if (authChoice === "claude-cli" || authChoice === "codex-cli") {
    runtime.error(
      [
        `Auth choice "${authChoice}" is deprecated.`,
        'Use "--auth-choice token" (Anthropic setup-token) or "--auth-choice openai-codex".',
      ].join("\n"),
    );
    runtime.exit(1);
    return null;
  }

  if (authChoice === "setup-token") {
    runtime.error(
      [
        'Auth choice "setup-token" requires interactive mode.',
        'Use "--auth-choice token" with --token and --token-provider anthropic.',
      ].join("\n"),
    );
    runtime.exit(1);
    return null;
  }

  if (authChoice === "vllm") {
    runtime.error(
      [
        'Auth choice "vllm" requires interactive mode.',
        "Use interactive onboard/configure to enter base URL, API key, and model ID.",
      ].join("\n"),
    );
    runtime.exit(1);
    return null;
  }

  if (authChoice === "apiKey") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "anthropic",
      cfg: baseConfig,
      flagValue: opts.anthropicApiKey,
      flagName: "--anthropic-api-key",
      envVar: "ANTHROPIC_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setAnthropicApiKey(resolved.key);
    }
    return applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });
  }

  if (authChoice === "token") {
    const providerRaw = opts.tokenProvider?.trim();
    if (!providerRaw) {
      runtime.error("Missing --token-provider for --auth-choice token.");
      runtime.exit(1);
      return null;
    }
    const provider = normalizeProviderId(providerRaw);
    if (provider !== "anthropic") {
      runtime.error("Only --token-provider anthropic is supported for --auth-choice token.");
      runtime.exit(1);
      return null;
    }
    const tokenRaw = normalizeSecretInput(opts.token);
    if (!tokenRaw) {
      runtime.error("Missing --token for --auth-choice token.");
      runtime.exit(1);
      return null;
    }
    const tokenError = validateAnthropicSetupToken(tokenRaw);
    if (tokenError) {
      runtime.error(tokenError);
      runtime.exit(1);
      return null;
    }

    let expires: number | undefined;
    const expiresInRaw = opts.tokenExpiresIn?.trim();
    if (expiresInRaw) {
      try {
        expires = Date.now() + parseDurationMs(expiresInRaw, { defaultUnit: "d" });
      } catch (err) {
        runtime.error(`Invalid --token-expires-in: ${String(err)}`);
        runtime.exit(1);
        return null;
      }
    }

    const profileId = opts.tokenProfileId?.trim() || buildTokenProfileId({ provider, name: "" });
    upsertAuthProfile({
      profileId,
      credential: {
        type: "token",
        provider,
        token: tokenRaw.trim(),
        ...(expires ? { expires } : {}),
      },
    });
    return applyAuthProfileConfig(nextConfig, {
      profileId,
      provider,
      mode: "token",
    });
  }

  if (authChoice === "gemini-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "google",
      cfg: baseConfig,
      flagValue: opts.geminiApiKey,
      flagName: "--gemini-api-key",
      envVar: "GEMINI_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setGeminiApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "google:default",
      provider: "google",
      mode: "api_key",
    });
    return applyGoogleGeminiModelDefault(nextConfig).next;
  }

  if (
    authChoice === "zai-api-key" ||
    authChoice === "zai-coding-global" ||
    authChoice === "zai-coding-cn" ||
    authChoice === "zai-global" ||
    authChoice === "zai-cn"
  ) {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "zai",
      cfg: baseConfig,
      flagValue: opts.zaiApiKey,
      flagName: "--zai-api-key",
      envVar: "ZAI_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setZaiApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "zai:default",
      provider: "zai",
      mode: "api_key",
    });

    // Determine endpoint from authChoice or detect from the API key.
    let endpoint: "global" | "cn" | "coding-global" | "coding-cn" | undefined;
    let modelIdOverride: string | undefined;

    if (authChoice === "zai-coding-global") {
      endpoint = "coding-global";
    } else if (authChoice === "zai-coding-cn") {
      endpoint = "coding-cn";
    } else if (authChoice === "zai-global") {
      endpoint = "global";
    } else if (authChoice === "zai-cn") {
      endpoint = "cn";
    } else {
      const detected = await detectZaiEndpoint({ apiKey: resolved.key });
      if (detected) {
        endpoint = detected.endpoint;
        modelIdOverride = detected.modelId;
      } else {
        endpoint = "global";
      }
    }

    return applyZaiConfig(nextConfig, {
      endpoint,
      ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
    });
  }

  if (authChoice === "xiaomi-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "xiaomi",
      cfg: baseConfig,
      flagValue: opts.xiaomiApiKey,
      flagName: "--xiaomi-api-key",
      envVar: "XIAOMI_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setXiaomiApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "xiaomi:default",
      provider: "xiaomi",
      mode: "api_key",
    });
    return applyXiaomiConfig(nextConfig);
  }

  if (authChoice === "xai-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "xai",
      cfg: baseConfig,
      flagValue: opts.xaiApiKey,
      flagName: "--xai-api-key",
      envVar: "XAI_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      setXaiApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "xai:default",
      provider: "xai",
      mode: "api_key",
    });
    return applyXaiConfig(nextConfig);
  }

  if (authChoice === "mistral-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "mistral",
      cfg: baseConfig,
      flagValue: opts.mistralApiKey,
      flagName: "--mistral-api-key",
      envVar: "MISTRAL_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setMistralApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "mistral:default",
      provider: "mistral",
      mode: "api_key",
    });
    return applyMistralConfig(nextConfig);
  }

  if (authChoice === "volcengine-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "volcengine",
      cfg: baseConfig,
      flagValue: opts.volcengineApiKey,
      flagName: "--volcengine-api-key",
      envVar: "VOLCANO_ENGINE_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      const result = upsertSharedEnvVar({
        key: "VOLCANO_ENGINE_API_KEY",
        value: resolved.key,
      });
      process.env.VOLCANO_ENGINE_API_KEY = resolved.key;
      runtime.log(`Saved VOLCANO_ENGINE_API_KEY to ${shortenHomePath(result.path)}`);
    }
    return applyPrimaryModel(nextConfig, "volcengine-plan/ark-code-latest");
  }

  if (authChoice === "byteplus-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "byteplus",
      cfg: baseConfig,
      flagValue: opts.byteplusApiKey,
      flagName: "--byteplus-api-key",
      envVar: "BYTEPLUS_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      const result = upsertSharedEnvVar({
        key: "BYTEPLUS_API_KEY",
        value: resolved.key,
      });
      process.env.BYTEPLUS_API_KEY = resolved.key;
      runtime.log(`Saved BYTEPLUS_API_KEY to ${shortenHomePath(result.path)}`);
    }
    return applyPrimaryModel(nextConfig, "byteplus-plan/ark-code-latest");
  }

  if (authChoice === "qianfan-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "qianfan",
      cfg: baseConfig,
      flagValue: opts.qianfanApiKey,
      flagName: "--qianfan-api-key",
      envVar: "QIANFAN_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      setQianfanApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "qianfan:default",
      provider: "qianfan",
      mode: "api_key",
    });
    return applyQianfanConfig(nextConfig);
  }

  if (authChoice === "openai-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "openai",
      cfg: baseConfig,
      flagValue: opts.openaiApiKey,
      flagName: "--openai-api-key",
      envVar: "OPENAI_API_KEY",
      runtime,
      allowProfile: false,
    });
    if (!resolved) {
      return null;
    }
    const key = resolved.key;
    const result = upsertSharedEnvVar({ key: "OPENAI_API_KEY", value: key });
    process.env.OPENAI_API_KEY = key;
    runtime.log(`Saved OPENAI_API_KEY to ${shortenHomePath(result.path)}`);
    return applyOpenAIConfig(nextConfig);
  }

  if (authChoice === "openrouter-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "openrouter",
      cfg: baseConfig,
      flagValue: opts.openrouterApiKey,
      flagName: "--openrouter-api-key",
      envVar: "OPENROUTER_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setOpenrouterApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "openrouter:default",
      provider: "openrouter",
      mode: "api_key",
    });
    return applyOpenrouterConfig(nextConfig);
  }

  if (authChoice === "kilocode-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "kilocode",
      cfg: baseConfig,
      flagValue: opts.kilocodeApiKey,
      flagName: "--kilocode-api-key",
      envVar: "KILOCODE_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setKilocodeApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "kilocode:default",
      provider: "kilocode",
      mode: "api_key",
    });
    return applyKilocodeConfig(nextConfig);
  }

  if (authChoice === "litellm-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "litellm",
      cfg: baseConfig,
      flagValue: opts.litellmApiKey,
      flagName: "--litellm-api-key",
      envVar: "LITELLM_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setLitellmApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "litellm:default",
      provider: "litellm",
      mode: "api_key",
    });
    return applyLitellmConfig(nextConfig);
  }

  if (authChoice === "ai-gateway-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "vercel-ai-gateway",
      cfg: baseConfig,
      flagValue: opts.aiGatewayApiKey,
      flagName: "--ai-gateway-api-key",
      envVar: "AI_GATEWAY_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setVercelAiGatewayApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "vercel-ai-gateway:default",
      provider: "vercel-ai-gateway",
      mode: "api_key",
    });
    return applyVercelAiGatewayConfig(nextConfig);
  }

  if (authChoice === "cloudflare-ai-gateway-api-key") {
    const accountId = opts.cloudflareAiGatewayAccountId?.trim() ?? "";
    const gatewayId = opts.cloudflareAiGatewayGatewayId?.trim() ?? "";
    if (!accountId || !gatewayId) {
      runtime.error(
        [
          'Auth choice "cloudflare-ai-gateway-api-key" requires Account ID and Gateway ID.',
          "Use --cloudflare-ai-gateway-account-id and --cloudflare-ai-gateway-gateway-id.",
        ].join("\n"),
      );
      runtime.exit(1);
      return null;
    }
    const resolved = await resolveNonInteractiveApiKey({
      provider: "cloudflare-ai-gateway",
      cfg: baseConfig,
      flagValue: opts.cloudflareAiGatewayApiKey,
      flagName: "--cloudflare-ai-gateway-api-key",
      envVar: "CLOUDFLARE_AI_GATEWAY_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setCloudflareAiGatewayConfig(accountId, gatewayId, resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "cloudflare-ai-gateway:default",
      provider: "cloudflare-ai-gateway",
      mode: "api_key",
    });
    return applyCloudflareAiGatewayConfig(nextConfig, {
      accountId,
      gatewayId,
    });
  }

  const applyMoonshotApiKeyChoice = async (
    applyConfig: (cfg: OpenClawConfig) => OpenClawConfig,
  ): Promise<OpenClawConfig | null> => {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "moonshot",
      cfg: baseConfig,
      flagValue: opts.moonshotApiKey,
      flagName: "--moonshot-api-key",
      envVar: "MOONSHOT_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setMoonshotApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "moonshot:default",
      provider: "moonshot",
      mode: "api_key",
    });
    return applyConfig(nextConfig);
  };

  if (authChoice === "moonshot-api-key") {
    return await applyMoonshotApiKeyChoice(applyMoonshotConfig);
  }

  if (authChoice === "moonshot-api-key-cn") {
    return await applyMoonshotApiKeyChoice(applyMoonshotConfigCn);
  }

  if (authChoice === "kimi-code-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "kimi-coding",
      cfg: baseConfig,
      flagValue: opts.kimiCodeApiKey,
      flagName: "--kimi-code-api-key",
      envVar: "KIMI_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setKimiCodingApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "kimi-coding:default",
      provider: "kimi-coding",
      mode: "api_key",
    });
    return applyKimiCodeConfig(nextConfig);
  }

  if (authChoice === "synthetic-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "synthetic",
      cfg: baseConfig,
      flagValue: opts.syntheticApiKey,
      flagName: "--synthetic-api-key",
      envVar: "SYNTHETIC_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setSyntheticApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "synthetic:default",
      provider: "synthetic",
      mode: "api_key",
    });
    return applySyntheticConfig(nextConfig);
  }

  if (authChoice === "venice-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "venice",
      cfg: baseConfig,
      flagValue: opts.veniceApiKey,
      flagName: "--venice-api-key",
      envVar: "VENICE_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setVeniceApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "venice:default",
      provider: "venice",
      mode: "api_key",
    });
    return applyVeniceConfig(nextConfig);
  }

  if (
    authChoice === "minimax-cloud" ||
    authChoice === "minimax-api" ||
    authChoice === "minimax-api-key-cn" ||
    authChoice === "minimax-api-lightning"
  ) {
    const isCn = authChoice === "minimax-api-key-cn";
    const providerId = isCn ? "minimax-cn" : "minimax";
    const profileId = `${providerId}:default`;
    const resolved = await resolveNonInteractiveApiKey({
      provider: providerId,
      cfg: baseConfig,
      flagValue: opts.minimaxApiKey,
      flagName: "--minimax-api-key",
      envVar: "MINIMAX_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setMinimaxApiKey(resolved.key, undefined, profileId);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId,
      provider: providerId,
      mode: "api_key",
    });
    const modelId =
      authChoice === "minimax-api-lightning" ? "MiniMax-M2.5-Lightning" : "MiniMax-M2.5";
    return isCn
      ? applyMinimaxApiConfigCn(nextConfig, modelId)
      : applyMinimaxApiConfig(nextConfig, modelId);
  }

  if (authChoice === "minimax") {
    return applyMinimaxConfig(nextConfig);
  }

  if (authChoice === "opencode-zen") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "opencode",
      cfg: baseConfig,
      flagValue: opts.opencodeZenApiKey,
      flagName: "--opencode-zen-api-key",
      envVar: "OPENCODE_API_KEY (or OPENCODE_ZEN_API_KEY)",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setOpencodeZenApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "opencode:default",
      provider: "opencode",
      mode: "api_key",
    });
    return applyOpencodeZenConfig(nextConfig);
  }

  if (authChoice === "together-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "together",
      cfg: baseConfig,
      flagValue: opts.togetherApiKey,
      flagName: "--together-api-key",
      envVar: "TOGETHER_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setTogetherApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "together:default",
      provider: "together",
      mode: "api_key",
    });
    return applyTogetherConfig(nextConfig);
  }

  if (authChoice === "huggingface-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "huggingface",
      cfg: baseConfig,
      flagValue: opts.huggingfaceApiKey,
      flagName: "--huggingface-api-key",
      envVar: "HF_TOKEN",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (resolved.source !== "profile") {
      await setHuggingfaceApiKey(resolved.key);
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "huggingface:default",
      provider: "huggingface",
      mode: "api_key",
    });
    return applyHuggingfaceConfig(nextConfig);
  }

  if (authChoice === "custom-api-key") {
    try {
      const customAuth = parseNonInteractiveCustomApiFlags({
        baseUrl: opts.customBaseUrl,
        modelId: opts.customModelId,
        compatibility: opts.customCompatibility,
        apiKey: opts.customApiKey,
        providerId: opts.customProviderId,
      });
      const resolvedProviderId = resolveCustomProviderId({
        config: nextConfig,
        baseUrl: customAuth.baseUrl,
        providerId: customAuth.providerId,
      });
      const resolvedCustomApiKey = await resolveNonInteractiveApiKey({
        provider: resolvedProviderId.providerId,
        cfg: baseConfig,
        flagValue: customAuth.apiKey,
        flagName: "--custom-api-key",
        envVar: "CUSTOM_API_KEY",
        envVarName: "CUSTOM_API_KEY",
        runtime,
        required: false,
      });
      const result = applyCustomApiConfig({
        config: nextConfig,
        baseUrl: customAuth.baseUrl,
        modelId: customAuth.modelId,
        compatibility: customAuth.compatibility,
        apiKey: resolvedCustomApiKey?.key,
        providerId: customAuth.providerId,
      });
      if (result.providerIdRenamedFrom && result.providerId) {
        runtime.log(
          `Custom provider ID "${result.providerIdRenamedFrom}" already exists for a different base URL. Using "${result.providerId}".`,
        );
      }
      return result.config;
    } catch (err) {
      if (err instanceof CustomApiError) {
        switch (err.code) {
          case "missing_required":
          case "invalid_compatibility":
            runtime.error(err.message);
            break;
          default:
            runtime.error(`Invalid custom provider config: ${err.message}`);
            break;
        }
        runtime.exit(1);
        return null;
      }
      const reason = err instanceof Error ? err.message : String(err);
      runtime.error(`Invalid custom provider config: ${reason}`);
      runtime.exit(1);
      return null;
    }
  }

  if (
    authChoice === "oauth" ||
    authChoice === "chutes" ||
    authChoice === "openai-codex" ||
    authChoice === "qwen-portal" ||
    authChoice === "minimax-portal"
  ) {
    runtime.error("OAuth requires interactive mode.");
    runtime.exit(1);
    return null;
  }

  return nextConfig;
}
