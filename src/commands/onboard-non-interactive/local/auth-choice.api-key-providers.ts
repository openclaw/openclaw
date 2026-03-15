import type { OpenClawConfig } from "../../../config/config.js";
import type { SecretInput } from "../../../config/types.secrets.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { applyGoogleGeminiModelDefault } from "../../google-gemini-model-default.js";
import { applyPrimaryModel } from "../../model-picker.js";
import {
  applyAuthProfileConfig,
  applyHuggingfaceConfig,
  applyKilocodeConfig,
  applyKimiCodeConfig,
  applyLitellmConfig,
  applyMistralConfig,
  applyModelStudioConfig,
  applyModelStudioConfigCn,
  applyMoonshotConfig,
  applyMoonshotConfigCn,
  applyOpencodeGoConfig,
  applyOpencodeZenConfig,
  applyOpenrouterConfig,
  applyErnieConfig,
  applyQianfanConfig,
  applySyntheticConfig,
  applyTogetherConfig,
  applyVeniceConfig,
  applyVercelAiGatewayConfig,
  applyXaiConfig,
  applyXiaomiConfig,
  setAnthropicApiKey,
  setGeminiApiKey,
  setHuggingfaceApiKey,
  setKilocodeApiKey,
  setKimiCodingApiKey,
  setLitellmApiKey,
  setMistralApiKey,
  setModelStudioApiKey,
  setMoonshotApiKey,
  setOpenaiApiKey,
  setOpencodeGoApiKey,
  setOpencodeZenApiKey,
  setOpenrouterApiKey,
  setErnieApiKey,
  setQianfanApiKey,
  setSyntheticApiKey,
  setTogetherApiKey,
  setVeniceApiKey,
  setVercelAiGatewayApiKey,
  setVolcengineApiKey,
  setXaiApiKey,
  setXiaomiApiKey,
  setByteplusApiKey,
} from "../../onboard-auth.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";
import { applyOpenAIConfig } from "../../openai-model-default.js";

type ApiKeyStorageOptions = {
  secretInputMode: "plaintext" | "ref";
};

type SimpleApiKeyAuthChoice = {
  authChoices: AuthChoice[];
  provider: string;
  flagValue?: string;
  flagName: `--${string}`;
  envVar: string;
  profileId: string;
  setCredential: (value: SecretInput, options?: ApiKeyStorageOptions) => Promise<void> | void;
  applyConfig: (cfg: OpenClawConfig) => OpenClawConfig;
};

type ResolvedNonInteractiveApiKey = {
  key: string;
  source: "profile" | "env" | "flag";
};

function buildSimpleApiKeyAuthChoices(params: { opts: OnboardOptions }): SimpleApiKeyAuthChoice[] {
  const withStorage =
    (
      setter: (
        value: SecretInput,
        agentDir?: string,
        options?: ApiKeyStorageOptions,
      ) => Promise<void> | void,
    ) =>
    (value: SecretInput, options?: ApiKeyStorageOptions) =>
      setter(value, undefined, options);

  return [
    {
      authChoices: ["apiKey"],
      provider: "anthropic",
      flagValue: params.opts.anthropicApiKey,
      flagName: "--anthropic-api-key",
      envVar: "ANTHROPIC_API_KEY",
      profileId: "anthropic:default",
      setCredential: withStorage(setAnthropicApiKey),
      applyConfig: (cfg) =>
        applyAuthProfileConfig(cfg, {
          profileId: "anthropic:default",
          provider: "anthropic",
          mode: "api_key",
        }),
    },
    {
      authChoices: ["gemini-api-key"],
      provider: "google",
      flagValue: params.opts.geminiApiKey,
      flagName: "--gemini-api-key",
      envVar: "GEMINI_API_KEY",
      profileId: "google:default",
      setCredential: withStorage(setGeminiApiKey),
      applyConfig: (cfg) =>
        applyGoogleGeminiModelDefault(
          applyAuthProfileConfig(cfg, {
            profileId: "google:default",
            provider: "google",
            mode: "api_key",
          }),
        ).next,
    },
    {
      authChoices: ["xiaomi-api-key"],
      provider: "xiaomi",
      flagValue: params.opts.xiaomiApiKey,
      flagName: "--xiaomi-api-key",
      envVar: "XIAOMI_API_KEY",
      profileId: "xiaomi:default",
      setCredential: withStorage(setXiaomiApiKey),
      applyConfig: (cfg) =>
        applyXiaomiConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "xiaomi:default",
            provider: "xiaomi",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["xai-api-key"],
      provider: "xai",
      flagValue: params.opts.xaiApiKey,
      flagName: "--xai-api-key",
      envVar: "XAI_API_KEY",
      profileId: "xai:default",
      setCredential: withStorage(setXaiApiKey),
      applyConfig: (cfg) =>
        applyXaiConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "xai:default",
            provider: "xai",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["mistral-api-key"],
      provider: "mistral",
      flagValue: params.opts.mistralApiKey,
      flagName: "--mistral-api-key",
      envVar: "MISTRAL_API_KEY",
      profileId: "mistral:default",
      setCredential: withStorage(setMistralApiKey),
      applyConfig: (cfg) =>
        applyMistralConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "mistral:default",
            provider: "mistral",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["volcengine-api-key"],
      provider: "volcengine",
      flagValue: params.opts.volcengineApiKey,
      flagName: "--volcengine-api-key",
      envVar: "VOLCANO_ENGINE_API_KEY",
      profileId: "volcengine:default",
      setCredential: withStorage(setVolcengineApiKey),
      applyConfig: (cfg) =>
        applyPrimaryModel(
          applyAuthProfileConfig(cfg, {
            profileId: "volcengine:default",
            provider: "volcengine",
            mode: "api_key",
          }),
          "volcengine-plan/ark-code-latest",
        ),
    },
    {
      authChoices: ["byteplus-api-key"],
      provider: "byteplus",
      flagValue: params.opts.byteplusApiKey,
      flagName: "--byteplus-api-key",
      envVar: "BYTEPLUS_API_KEY",
      profileId: "byteplus:default",
      setCredential: withStorage(setByteplusApiKey),
      applyConfig: (cfg) =>
        applyPrimaryModel(
          applyAuthProfileConfig(cfg, {
            profileId: "byteplus:default",
            provider: "byteplus",
            mode: "api_key",
          }),
          "byteplus-plan/ark-code-latest",
        ),
    },
    {
      authChoices: ["qianfan-api-key"],
      provider: "qianfan",
      flagValue: params.opts.qianfanApiKey,
      flagName: "--qianfan-api-key",
      envVar: "QIANFAN_API_KEY",
      profileId: "qianfan:default",
      setCredential: withStorage(setQianfanApiKey),
      applyConfig: (cfg) =>
        applyQianfanConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "qianfan:default",
            provider: "qianfan",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["ernie-api-key"],
      provider: "ernie",
      flagValue: params.opts.ernieApiKey,
      flagName: "--ernie-api-key",
      envVar: "ERNIE_API_KEY",
      profileId: "ernie:default",
      setCredential: withStorage(setErnieApiKey),
      applyConfig: (cfg) =>
        applyErnieConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "ernie:default",
            provider: "ernie",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["modelstudio-api-key-cn"],
      provider: "modelstudio",
      flagValue: params.opts.modelstudioApiKeyCn,
      flagName: "--modelstudio-api-key-cn",
      envVar: "MODELSTUDIO_API_KEY",
      profileId: "modelstudio:default",
      setCredential: withStorage(setModelStudioApiKey),
      applyConfig: (cfg) =>
        applyModelStudioConfigCn(
          applyAuthProfileConfig(cfg, {
            profileId: "modelstudio:default",
            provider: "modelstudio",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["modelstudio-api-key"],
      provider: "modelstudio",
      flagValue: params.opts.modelstudioApiKey,
      flagName: "--modelstudio-api-key",
      envVar: "MODELSTUDIO_API_KEY",
      profileId: "modelstudio:default",
      setCredential: withStorage(setModelStudioApiKey),
      applyConfig: (cfg) =>
        applyModelStudioConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "modelstudio:default",
            provider: "modelstudio",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["openai-api-key"],
      provider: "openai",
      flagValue: params.opts.openaiApiKey,
      flagName: "--openai-api-key",
      envVar: "OPENAI_API_KEY",
      profileId: "openai:default",
      setCredential: withStorage(setOpenaiApiKey),
      applyConfig: (cfg) =>
        applyOpenAIConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "openai:default",
            provider: "openai",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["openrouter-api-key"],
      provider: "openrouter",
      flagValue: params.opts.openrouterApiKey,
      flagName: "--openrouter-api-key",
      envVar: "OPENROUTER_API_KEY",
      profileId: "openrouter:default",
      setCredential: withStorage(setOpenrouterApiKey),
      applyConfig: (cfg) =>
        applyOpenrouterConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "openrouter:default",
            provider: "openrouter",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["kilocode-api-key"],
      provider: "kilocode",
      flagValue: params.opts.kilocodeApiKey,
      flagName: "--kilocode-api-key",
      envVar: "KILOCODE_API_KEY",
      profileId: "kilocode:default",
      setCredential: withStorage(setKilocodeApiKey),
      applyConfig: (cfg) =>
        applyKilocodeConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "kilocode:default",
            provider: "kilocode",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["litellm-api-key"],
      provider: "litellm",
      flagValue: params.opts.litellmApiKey,
      flagName: "--litellm-api-key",
      envVar: "LITELLM_API_KEY",
      profileId: "litellm:default",
      setCredential: withStorage(setLitellmApiKey),
      applyConfig: (cfg) =>
        applyLitellmConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "litellm:default",
            provider: "litellm",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["ai-gateway-api-key"],
      provider: "vercel-ai-gateway",
      flagValue: params.opts.aiGatewayApiKey,
      flagName: "--ai-gateway-api-key",
      envVar: "AI_GATEWAY_API_KEY",
      profileId: "vercel-ai-gateway:default",
      setCredential: withStorage(setVercelAiGatewayApiKey),
      applyConfig: (cfg) =>
        applyVercelAiGatewayConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "vercel-ai-gateway:default",
            provider: "vercel-ai-gateway",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["moonshot-api-key"],
      provider: "moonshot",
      flagValue: params.opts.moonshotApiKey,
      flagName: "--moonshot-api-key",
      envVar: "MOONSHOT_API_KEY",
      profileId: "moonshot:default",
      setCredential: withStorage(setMoonshotApiKey),
      applyConfig: (cfg) =>
        applyMoonshotConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "moonshot:default",
            provider: "moonshot",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["moonshot-api-key-cn"],
      provider: "moonshot",
      flagValue: params.opts.moonshotApiKey,
      flagName: "--moonshot-api-key",
      envVar: "MOONSHOT_API_KEY",
      profileId: "moonshot:default",
      setCredential: withStorage(setMoonshotApiKey),
      applyConfig: (cfg) =>
        applyMoonshotConfigCn(
          applyAuthProfileConfig(cfg, {
            profileId: "moonshot:default",
            provider: "moonshot",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["kimi-code-api-key"],
      provider: "kimi-coding",
      flagValue: params.opts.kimiCodeApiKey,
      flagName: "--kimi-code-api-key",
      envVar: "KIMI_API_KEY",
      profileId: "kimi-coding:default",
      setCredential: withStorage(setKimiCodingApiKey),
      applyConfig: (cfg) =>
        applyKimiCodeConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "kimi-coding:default",
            provider: "kimi-coding",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["synthetic-api-key"],
      provider: "synthetic",
      flagValue: params.opts.syntheticApiKey,
      flagName: "--synthetic-api-key",
      envVar: "SYNTHETIC_API_KEY",
      profileId: "synthetic:default",
      setCredential: withStorage(setSyntheticApiKey),
      applyConfig: (cfg) =>
        applySyntheticConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "synthetic:default",
            provider: "synthetic",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["venice-api-key"],
      provider: "venice",
      flagValue: params.opts.veniceApiKey,
      flagName: "--venice-api-key",
      envVar: "VENICE_API_KEY",
      profileId: "venice:default",
      setCredential: withStorage(setVeniceApiKey),
      applyConfig: (cfg) =>
        applyVeniceConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "venice:default",
            provider: "venice",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["opencode-zen"],
      provider: "opencode",
      flagValue: params.opts.opencodeZenApiKey,
      flagName: "--opencode-zen-api-key",
      envVar: "OPENCODE_API_KEY (or OPENCODE_ZEN_API_KEY)",
      profileId: "opencode:default",
      setCredential: withStorage(setOpencodeZenApiKey),
      applyConfig: (cfg) =>
        applyOpencodeZenConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "opencode:default",
            provider: "opencode",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["opencode-go"],
      provider: "opencode-go",
      flagValue: params.opts.opencodeGoApiKey,
      flagName: "--opencode-go-api-key",
      envVar: "OPENCODE_API_KEY",
      profileId: "opencode-go:default",
      setCredential: withStorage(setOpencodeGoApiKey),
      applyConfig: (cfg) =>
        applyOpencodeGoConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "opencode-go:default",
            provider: "opencode-go",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["together-api-key"],
      provider: "together",
      flagValue: params.opts.togetherApiKey,
      flagName: "--together-api-key",
      envVar: "TOGETHER_API_KEY",
      profileId: "together:default",
      setCredential: withStorage(setTogetherApiKey),
      applyConfig: (cfg) =>
        applyTogetherConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "together:default",
            provider: "together",
            mode: "api_key",
          }),
        ),
    },
    {
      authChoices: ["huggingface-api-key"],
      provider: "huggingface",
      flagValue: params.opts.huggingfaceApiKey,
      flagName: "--huggingface-api-key",
      envVar: "HF_TOKEN",
      profileId: "huggingface:default",
      setCredential: withStorage(setHuggingfaceApiKey),
      applyConfig: (cfg) =>
        applyHuggingfaceConfig(
          applyAuthProfileConfig(cfg, {
            profileId: "huggingface:default",
            provider: "huggingface",
            mode: "api_key",
          }),
        ),
    },
  ];
}

export async function applySimpleNonInteractiveApiKeyChoice(params: {
  authChoice: AuthChoice;
  nextConfig: OpenClawConfig;
  baseConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  apiKeyStorageOptions?: ApiKeyStorageOptions;
  resolveApiKey: (input: {
    provider: string;
    cfg: OpenClawConfig;
    flagValue?: string;
    flagName: `--${string}`;
    envVar: string;
    runtime: RuntimeEnv;
  }) => Promise<ResolvedNonInteractiveApiKey | null>;
  maybeSetResolvedApiKey: (
    resolved: ResolvedNonInteractiveApiKey,
    setter: (value: SecretInput) => Promise<void> | void,
  ) => Promise<boolean>;
}): Promise<OpenClawConfig | null | undefined> {
  const definition = buildSimpleApiKeyAuthChoices({
    opts: params.opts,
  }).find((entry) => entry.authChoices.includes(params.authChoice));
  if (!definition) {
    return undefined;
  }

  const resolved = await params.resolveApiKey({
    provider: definition.provider,
    cfg: params.baseConfig,
    flagValue: definition.flagValue,
    flagName: definition.flagName,
    envVar: definition.envVar,
    runtime: params.runtime,
  });
  if (!resolved) {
    return null;
  }
  if (
    !(await params.maybeSetResolvedApiKey(resolved, (value) =>
      definition.setCredential(value, params.apiKeyStorageOptions),
    ))
  ) {
    return null;
  }
  return definition.applyConfig(params.nextConfig);
}
