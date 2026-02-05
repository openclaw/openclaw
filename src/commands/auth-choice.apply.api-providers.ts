import http from "node:http";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";
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
  applyPuterConfig,
  applyPuterProviderConfig,
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
  PUTER_DEFAULT_MODEL_ID,
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
  setPuterApiKey,
  setSyntheticApiKey,
  setVeniceApiKey,
  setVercelAiGatewayApiKey,
  setXiaomiApiKey,
  setZaiApiKey,
  ZAI_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";
import { OPENCODE_ZEN_DEFAULT_MODEL } from "./opencode-zen-model-default.js";

const PUTER_MODELS_ENDPOINT = "https://api.puter.com/puterai/chat/models";
const PUTER_MODEL_PICKER_DEFAULT = "__default__";
const PUTER_MODEL_PICKER_MANUAL = "__manual__";
const PUTER_WEB_ORIGIN = "https://puter.com";
const PUTER_AUTH_TIMEOUT_MS = 120_000;

function normalizePuterModelIds(models: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function extractPuterModelId(entry: unknown): string | null {
  if (typeof entry === "string") {
    return entry.trim() || null;
  }
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const candidateKeys = ["id", "model", "name"];
  for (const key of candidateKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

async function getPuterAuthToken(params: {
  prompter: WizardPrompter;
  guiOrigin?: string;
}): Promise<string | undefined> {
  const guiOrigin = params.guiOrigin?.trim() || PUTER_WEB_ORIGIN;
  return await new Promise((resolve) => {
    let finished = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (token?: string) => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (server.listening) {
        server.close(() => resolve(token));
      } else {
        resolve(token);
      }
    };
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authentication Successful - Puter</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: #404C71;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .container {
            background: white;
            border-radius: 16px;
            padding: 48px;
            text-align: center;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
            max-width: 420px;
            margin: 20px;
        }
        .checkmark {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #00c853 0%, #00e676 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
            animation: scaleIn 0.5s ease-out;
        }
        .checkmark svg {
            width: 40px;
            height: 40px;
            stroke: white;
            stroke-width: 3;
            fill: none;
            animation: drawCheck 0.6s ease-out 0.3s forwards;
            stroke-dasharray: 50;
            stroke-dashoffset: 50;
        }
        @keyframes scaleIn {
            0% { transform: scale(0); }
            50% { transform: scale(1.2); }
            100% { transform: scale(1); }
        }
        @keyframes drawCheck {
            to { stroke-dashoffset: 0; }
        }
        h1 {
            color: #1a1a2e;
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 12px;
        }
        p {
            color: #64748b;
            font-size: 16px;
            line-height: 1.6;
        }
        .puter-logo {
            margin-top: 32px;
            opacity: 0.6;
            font-size: 14px;
            color: #94a3b8;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="checkmark">
            <svg viewBox="0 0 24 24">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
        </div>
        <h1>Authentication Successful</h1>
        <p>You're all set! You may now close this window and return to your terminal.</p>
        <div class="puter-logo">Powered by Puter</div>
    </div>
</body>
</html>`);

      const url = new URL(req.url ?? "/", "http://localhost/");
      const token = url.searchParams.get("token")?.trim() || undefined;
      finish(token);
    });

    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => finish(undefined));
        return;
      }
      timeout = setTimeout(() => {
        server.close(() => finish(undefined));
      }, PUTER_AUTH_TIMEOUT_MS);

      const redirectUrl = `http://localhost:${address.port}`;
      const authUrl = `${guiOrigin}/?action=authme&redirectURL=${encodeURIComponent(redirectUrl)}`;
      const opened = await openUrl(authUrl);
      if (!opened) {
        await params.prompter.note(
          ["Open this URL to complete Puter login:", authUrl].join("\n"),
          "Puter web login",
        );
      }
    });
  });
}

async function fetchPuterModelIds(apiKey?: string): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  try {
    const response = await fetch(PUTER_MODELS_ENDPOINT, {
      headers,
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as unknown;
    let entries: unknown[] = [];
    if (Array.isArray(payload)) {
      entries = payload;
    } else if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      if (Array.isArray(record.data)) {
        entries = record.data;
      } else if (Array.isArray(record.models)) {
        entries = record.models;
      }
    }
    const ids = entries
      .map((entry) => extractPuterModelId(entry))
      .filter((value): value is string => Boolean(value));
    return normalizePuterModelIds(ids);
  } catch {
    return [];
  }
}

async function resolvePuterModelId(params: {
  apiKey?: string;
  prompter: WizardPrompter;
}): Promise<string> {
  const progress = params.prompter.progress("Fetching Puter models…");
  const models = await fetchPuterModelIds(params.apiKey);
  progress.stop();

  if (models.length === 0) {
    return PUTER_DEFAULT_MODEL_ID;
  }

  const filtered = models.filter((model) => model !== PUTER_DEFAULT_MODEL_ID);
  const options: WizardSelectOption[] = [
    {
      value: PUTER_MODEL_PICKER_DEFAULT,
      label: `Default (${PUTER_DEFAULT_MODEL_ID})`,
    },
    {
      value: PUTER_MODEL_PICKER_MANUAL,
      label: "Enter model manually",
    },
    ...filtered.map((model) => ({ value: model, label: model })),
  ];

  const selection = await params.prompter.select({
    message: "Select Puter model",
    options,
    initialValue: PUTER_MODEL_PICKER_DEFAULT,
  });

  if (selection === PUTER_MODEL_PICKER_DEFAULT) {
    return PUTER_DEFAULT_MODEL_ID;
  }
  if (selection === PUTER_MODEL_PICKER_MANUAL) {
    const manual = await params.prompter.text({
      message: "Puter model id",
      initialValue: PUTER_DEFAULT_MODEL_ID,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    return manual.trim() || PUTER_DEFAULT_MODEL_ID;
  }
  return selection.trim() || PUTER_DEFAULT_MODEL_ID;
}

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

  if (authChoice === "puter-api-key" || authChoice === "puter-web") {
    let hasCredential = false;
    let resolvedApiKey: string | undefined;

    if (authChoice === "puter-web") {
      const token = await getPuterAuthToken({ prompter: params.prompter });
      if (token) {
        resolvedApiKey = token;
        await setPuterApiKey(token, params.agentDir);
        hasCredential = true;
      } else {
        await params.prompter.note(
          "Puter web login did not return a token. Falling back to API key entry.",
          "Puter web login",
        );
      }
    }

    if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "puter") {
      resolvedApiKey = normalizeApiKeyInput(params.opts.token);
      await setPuterApiKey(resolvedApiKey, params.agentDir);
      hasCredential = true;
    }

    const envKey = resolveEnvApiKey("puter");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing PUTER_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setPuterApiKey(envKey.apiKey, params.agentDir);
        resolvedApiKey = envKey.apiKey;
        hasCredential = true;
      }
    }
    if (!hasCredential) {
      const key = await params.prompter.text({
        message: "Enter API key from https://puter.com/?action=copyauth",
        validate: validateApiKeyInput,
      });
      resolvedApiKey = normalizeApiKeyInput(String(key));
      await setPuterApiKey(resolvedApiKey, params.agentDir);
    }

    const modelId = await resolvePuterModelId({
      apiKey: resolvedApiKey,
      prompter: params.prompter,
    });
    const modelRef = `puter/${modelId}`;

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "puter:default",
      provider: "puter",
      mode: "api_key",
    });
    {
      const applied = await applyDefaultModelChoice({
        config: nextConfig,
        setDefaultModel: params.setDefaultModel,
        defaultModel: modelRef,
        applyDefaultConfig: (config) => applyPuterConfig(config, modelId),
        applyProviderConfig: (config) => applyPuterProviderConfig(config, modelId),
        noteDefault: modelRef,
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

  return null;
}
