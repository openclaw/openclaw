import { upsertAuthProfile } from "../../../agents/auth-profiles.js";
import type { ApiKeyCredential } from "../../../agents/auth-profiles/types.js";
import { normalizeProviderId } from "../../../agents/model-selection.js";
import { parseDurationMs } from "../../../cli/parse-duration.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { SecretInput } from "../../../config/types.secrets.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { resolveDefaultSecretProviderAlias } from "../../../secrets/ref-contract.js";
import { normalizeSecretInput } from "../../../utils/normalize-secret-input.js";
import { normalizeSecretInputModeInput } from "../../auth-choice.apply-helpers.js";
import { buildTokenProfileId, validateAnthropicSetupToken } from "../../auth-token.js";
import {
  applyAuthProfileConfig,
  applyCloudflareAiGatewayConfig,
  applyKilocodeConfig,
  applyQianfanConfig,
  applyModelStudioConfig,
  applyModelStudioConfigCn,
  applyModelStudioStandardConfig,
  applyModelStudioStandardConfigCn,
  applyKimiCodeConfig,
  applyMinimaxApiConfig,
  applyMinimaxApiConfigCn,
  applyZaiConfig,
  setCloudflareAiGatewayConfig,
  setMinimaxApiKey,
  setZaiApiKey,
} from "../../onboard-auth.js";
import {
  applyCustomApiConfig,
  CustomApiError,
  parseNonInteractiveCustomApiFlags,
  resolveCustomProviderId,
} from "../../onboard-custom.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";
import { detectZaiEndpoint } from "../../zai-endpoint-detect.js";
import { resolveNonInteractiveApiKey } from "../api-keys.js";
import { applySimpleNonInteractiveApiKeyChoice } from "./auth-choice.api-key-providers.js";
import { applyNonInteractivePluginProviderChoice } from "./auth-choice.plugin-providers.js";

type ResolvedNonInteractiveApiKey = NonNullable<
  Awaited<ReturnType<typeof resolveNonInteractiveApiKey>>
>;

export async function applyNonInteractiveAuthChoice(params: {
  nextConfig: OpenClawConfig;
  authChoice: AuthChoice;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
}): Promise<OpenClawConfig | null> {
  const { authChoice, opts, runtime, baseConfig } = params;
  let nextConfig = params.nextConfig;
  const requestedSecretInputMode = normalizeSecretInputModeInput(opts.secretInputMode);
  if (opts.secretInputMode && !requestedSecretInputMode) {
    runtime.error('Invalid --secret-input-mode. Use "plaintext" or "ref".');
    runtime.exit(1);
    return null;
  }
  const apiKeyStorageOptions = requestedSecretInputMode
    ? { secretInputMode: requestedSecretInputMode }
    : undefined;
  const toStoredSecretInput = (resolved: ResolvedNonInteractiveApiKey): SecretInput | null => {
    const storePlaintextSecret = requestedSecretInputMode !== "ref"; // pragma: allowlist secret
    if (storePlaintextSecret) {
      return resolved.key;
    }
    if (resolved.source !== "env") {
      return resolved.key;
    }
    if (!resolved.envVarName) {
      runtime.error(
        [
          `Unable to determine which environment variable to store as a ref for provider "${authChoice}".`,
          "Set an explicit provider env var and retry, or use --secret-input-mode plaintext.",
        ].join("\n"),
      );
      runtime.exit(1);
      return null;
    }
    return {
      source: "env",
      provider: resolveDefaultSecretProviderAlias(baseConfig, "env", {
        preferFirstProviderForSource: true,
      }),
      id: resolved.envVarName,
    };
  };
  const resolveApiKey = (input: Parameters<typeof resolveNonInteractiveApiKey>[0]) =>
    resolveNonInteractiveApiKey({
      ...input,
      secretInputMode: requestedSecretInputMode,
    });
  const toApiKeyCredential = (params: {
    provider: string;
    resolved: ResolvedNonInteractiveApiKey;
    email?: string;
    metadata?: Record<string, string>;
  }): ApiKeyCredential | null => {
    const storeSecretRef = requestedSecretInputMode === "ref" && params.resolved.source === "env"; // pragma: allowlist secret
    if (storeSecretRef) {
      if (!params.resolved.envVarName) {
        runtime.error(
          [
            `--secret-input-mode ref requires an explicit environment variable for provider "${params.provider}".`,
            "Set the provider API key env var and retry, or use --secret-input-mode plaintext.",
          ].join("\n"),
        );
        runtime.exit(1);
        return null;
      }
      return {
        type: "api_key",
        provider: params.provider,
        keyRef: {
          source: "env",
          provider: resolveDefaultSecretProviderAlias(baseConfig, "env", {
            preferFirstProviderForSource: true,
          }),
          id: params.resolved.envVarName,
        },
        ...(params.email ? { email: params.email } : {}),
        ...(params.metadata ? { metadata: params.metadata } : {}),
      };
    }
    return {
      type: "api_key",
      provider: params.provider,
      key: params.resolved.key,
      ...(params.email ? { email: params.email } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
  };
  const maybeSetResolvedApiKey = async (
    resolved: ResolvedNonInteractiveApiKey,
    setter: (value: SecretInput) => Promise<void> | void,
  ): Promise<boolean> => {
    if (resolved.source === "profile") {
      return true;
    }
    const stored = toStoredSecretInput(resolved);
    if (!stored) {
      return false;
    }
    await setter(stored);
    return true;
  };

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

  const pluginProviderChoice = await applyNonInteractivePluginProviderChoice({
    nextConfig,
    authChoice,
    opts,
    runtime,
    baseConfig,
    resolveApiKey: (input) =>
      resolveApiKey({
        ...input,
        cfg: baseConfig,
        runtime,
      }),
    toApiKeyCredential,
  });
  if (pluginProviderChoice !== undefined) {
    return pluginProviderChoice;
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

  const simpleApiKeyChoice = await applySimpleNonInteractiveApiKeyChoice({
    authChoice,
    nextConfig,
    baseConfig,
    opts,
    runtime,
    apiKeyStorageOptions,
    resolveApiKey,
    maybeSetResolvedApiKey,
  });
  if (simpleApiKeyChoice !== undefined) {
    return simpleApiKeyChoice;
  }

  if (
    authChoice === "zai-api-key" ||
    authChoice === "zai-coding-global" ||
    authChoice === "zai-coding-cn" ||
    authChoice === "zai-global" ||
    authChoice === "zai-cn"
  ) {
    const resolved = await resolveApiKey({
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
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setZaiApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
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
    }

    if (endpoint) {
      const detected = await detectZaiEndpoint({ apiKey: resolved.key, endpoint });
      if (detected) {
        modelIdOverride = detected.modelId;
      }
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
    const resolved = await resolveApiKey({
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
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setXiaomiApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "xiaomi:default",
      provider: "xiaomi",
      mode: "api_key",
    });
    return applyXiaomiConfig(nextConfig);
  }

  if (authChoice === "xai-api-key") {
    const resolved = await resolveApiKey({
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
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setXaiApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "xai:default",
      provider: "xai",
      mode: "api_key",
    });
    return applyXaiConfig(nextConfig);
  }

  if (authChoice === "mistral-api-key") {
    const resolved = await resolveApiKey({
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
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setMistralApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "mistral:default",
      provider: "mistral",
      mode: "api_key",
    });
    return applyMistralConfig(nextConfig);
  }

  if (authChoice === "volcengine-api-key") {
    const resolved = await resolveApiKey({
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
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setVolcengineApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "volcengine:default",
      provider: "volcengine",
      mode: "api_key",
    });
    return applyPrimaryModel(nextConfig, "volcengine-plan/ark-code-latest");
  }

  if (authChoice === "byteplus-api-key") {
    const resolved = await resolveApiKey({
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
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setByteplusApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "byteplus:default",
      provider: "byteplus",
      mode: "api_key",
    });
    return applyPrimaryModel(nextConfig, "byteplus-plan/ark-code-latest");
  }

  if (authChoice === "qianfan-api-key") {
    const resolved = await resolveApiKey({
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
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setQianfanApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "qianfan:default",
      provider: "qianfan",
      mode: "api_key",
    });
    return applyQianfanConfig(nextConfig);
  }

  if (authChoice === "modelstudio-standard-api-key-cn") {
    const resolved = await resolveApiKey({
      provider: "modelstudio",
      cfg: baseConfig,
      flagValue: opts.modelstudioStandardApiKeyCn,
      flagName: "--modelstudio-standard-api-key-cn",
      envVar: "MODELSTUDIO_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setModelStudioApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "modelstudio:default",
      provider: "modelstudio",
      mode: "api_key",
    });
    return applyModelStudioStandardConfigCn(nextConfig);
  }

  if (authChoice === "modelstudio-standard-api-key") {
    const resolved = await resolveApiKey({
      provider: "modelstudio",
      cfg: baseConfig,
      flagValue: opts.modelstudioStandardApiKey,
      flagName: "--modelstudio-standard-api-key",
      envVar: "MODELSTUDIO_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setModelStudioApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "modelstudio:default",
      provider: "modelstudio",
      mode: "api_key",
    });
    return applyModelStudioStandardConfig(nextConfig);
  }

  if (authChoice === "modelstudio-api-key-cn") {
    const resolved = await resolveApiKey({
      provider: "modelstudio",
      cfg: baseConfig,
      flagValue: opts.modelstudioApiKeyCn,
      flagName: "--modelstudio-api-key-cn",
      envVar: "MODELSTUDIO_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setModelStudioApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "modelstudio:default",
      provider: "modelstudio",
      mode: "api_key",
    });
    return applyModelStudioConfigCn(nextConfig);
  }

  if (authChoice === "modelstudio-api-key") {
    const resolved = await resolveApiKey({
      provider: "modelstudio",
      cfg: baseConfig,
      flagValue: opts.modelstudioApiKey,
      flagName: "--modelstudio-api-key",
      envVar: "MODELSTUDIO_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setModelStudioApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "modelstudio:default",
      provider: "modelstudio",
      mode: "api_key",
    });
    return applyModelStudioConfig(nextConfig);
  }

  if (authChoice === "openai-api-key") {
    const resolved = await resolveApiKey({
      provider: "openai",
      cfg: baseConfig,
      flagValue: opts.openaiApiKey,
      flagName: "--openai-api-key",
      envVar: "OPENAI_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setOpenaiApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "openai:default",
      provider: "openai",
      mode: "api_key",
    });
    return applyOpenAIConfig(nextConfig);
  }

  if (authChoice === "openrouter-api-key") {
    const resolved = await resolveApiKey({
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
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setOpenrouterApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "openrouter:default",
      provider: "openrouter",
      mode: "api_key",
    });
    return applyOpenrouterConfig(nextConfig);
  }

  if (authChoice === "kilocode-api-key") {
    const resolved = await resolveApiKey({
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
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setKilocodeApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "kilocode:default",
      provider: "kilocode",
      mode: "api_key",
    });
    return applyKilocodeConfig(nextConfig);
  }

  if (authChoice === "litellm-api-key") {
    const resolved = await resolveApiKey({
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
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setLitellmApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "litellm:default",
      provider: "litellm",
      mode: "api_key",
    });
    return applyLitellmConfig(nextConfig);
  }

  if (authChoice === "ai-gateway-api-key") {
    const resolved = await resolveApiKey({
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
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setVercelAiGatewayApiKey(value, undefined, apiKeyStorageOptions),
      ))
    ) {
      return null;
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
    const resolved = await resolveApiKey({
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
      const stored = toStoredSecretInput(resolved);
      if (!stored) {
        return null;
      }
      await setCloudflareAiGatewayConfig(
        accountId,
        gatewayId,
        stored,
        undefined,
        apiKeyStorageOptions,
      );
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

  // Legacy aliases: these choice values were removed; fail with an actionable message so
  // existing CI automation gets a clear error instead of silently exiting 0 with no auth.
  const REMOVED_MINIMAX_CHOICES: Record<string, string> = {
    minimax: "minimax-global-api",
    "minimax-api": "minimax-global-api",
    "minimax-cloud": "minimax-global-api",
    "minimax-api-lightning": "minimax-global-api",
    "minimax-api-key-cn": "minimax-cn-api",
  };
  if (Object.prototype.hasOwnProperty.call(REMOVED_MINIMAX_CHOICES, authChoice as string)) {
    const replacement = REMOVED_MINIMAX_CHOICES[authChoice as string];
    runtime.error(
      `"${authChoice as string}" is no longer supported. Use --auth-choice ${replacement} instead.`,
    );
    runtime.exit(1);
    return null;
  }

  if (authChoice === "minimax-global-api" || authChoice === "minimax-cn-api") {
    const isCn = authChoice === "minimax-cn-api";
    const profileId = isCn ? "minimax:cn" : "minimax:global";
    const resolved = await resolveApiKey({
      provider: "minimax",
      cfg: baseConfig,
      flagValue: opts.minimaxApiKey,
      flagName: "--minimax-api-key",
      envVar: "MINIMAX_API_KEY",
      runtime,
      // Disable profile fallback: both regions share provider "minimax", so an existing
      // Global profile key must not be silently reused when configuring CN (and vice versa).
      allowProfile: false,
    });
    if (!resolved) {
      return null;
    }
    if (
      !(await maybeSetResolvedApiKey(resolved, (value) =>
        setMinimaxApiKey(value, undefined, profileId, apiKeyStorageOptions),
      ))
    ) {
      return null;
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId,
      provider: "minimax",
      mode: "api_key",
    });
    return isCn ? applyMinimaxApiConfigCn(nextConfig) : applyMinimaxApiConfig(nextConfig);
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
      const resolvedCustomApiKey = await resolveApiKey({
        provider: resolvedProviderId.providerId,
        cfg: baseConfig,
        flagValue: customAuth.apiKey,
        flagName: "--custom-api-key",
        envVar: "CUSTOM_API_KEY",
        envVarName: "CUSTOM_API_KEY",
        runtime,
        required: false,
      });
      let customApiKeyInput: SecretInput | undefined;
      if (resolvedCustomApiKey) {
        const storeCustomApiKeyAsRef = requestedSecretInputMode === "ref"; // pragma: allowlist secret
        if (storeCustomApiKeyAsRef) {
          const stored = toStoredSecretInput(resolvedCustomApiKey);
          if (!stored) {
            return null;
          }
          customApiKeyInput = stored;
        } else {
          customApiKeyInput = resolvedCustomApiKey.key;
        }
      }
      const result = applyCustomApiConfig({
        config: nextConfig,
        baseUrl: customAuth.baseUrl,
        modelId: customAuth.modelId,
        compatibility: customAuth.compatibility,
        apiKey: customApiKeyInput,
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
    authChoice === "minimax-global-oauth" ||
    authChoice === "minimax-cn-oauth"
  ) {
    runtime.error("OAuth requires interactive mode.");
    runtime.exit(1);
    return null;
  }

  return nextConfig;
}
