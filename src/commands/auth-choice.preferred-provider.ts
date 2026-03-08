import type { OpenClawConfig } from "../config/config.js";
import { normalizeLegacyOnboardAuthChoice } from "./auth-choice-legacy.js";
import type { AuthChoice } from "./onboard-types.js";

const PREFERRED_PROVIDER_BY_AUTH_CHOICE: Partial<Record<AuthChoice, string>> = {
  chutes: "chutes",
  token: "anthropic",
  apiKey: "anthropic",
  "openai-codex": "openai-codex",
  "openai-api-key": "openai",
  "azure-openai-api-key": "azure-openai-responses",
  "openrouter-api-key": "openrouter",
  "kilocode-api-key": "kilocode",
  "ai-gateway-api-key": "vercel-ai-gateway",
  "cloudflare-ai-gateway-api-key": "cloudflare-ai-gateway",
  "moonshot-api-key": "moonshot",
  "moonshot-api-key-cn": "moonshot",
  "kimi-code-api-key": "kimi-coding",
  "gemini-api-key": "google",
  "google-gemini-cli": "google-gemini-cli",
  "mistral-api-key": "mistral",
  ollama: "ollama",
  sglang: "sglang",
  "zai-api-key": "zai",
  "zai-coding-global": "zai",
  "zai-coding-cn": "zai",
  "zai-global": "zai",
  "zai-cn": "zai",
  "xiaomi-api-key": "xiaomi",
  "synthetic-api-key": "synthetic",
  "venice-api-key": "venice",
  "together-api-key": "together",
  "huggingface-api-key": "huggingface",
  "github-copilot": "github-copilot",
  "copilot-proxy": "copilot-proxy",
  "minimax-global-oauth": "minimax-portal",
  "minimax-global-api": "minimax",
  "minimax-cn-oauth": "minimax-portal",
  "minimax-cn-api": "minimax",
  "opencode-zen": "opencode",
  "opencode-go": "opencode-go",
  "xai-api-key": "xai",
  "litellm-api-key": "litellm",
  "qwen-portal": "qwen-portal",
  "volcengine-api-key": "volcengine",
  "byteplus-api-key": "byteplus",
  "qianfan-api-key": "qianfan",
  "custom-api-key": "custom",
  vllm: "vllm",
};

export async function resolvePreferredProviderForAuthChoice(params: {
  choice: AuthChoice;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const choice = normalizeLegacyOnboardAuthChoice(params.choice) ?? params.choice;
  const [{ resolveProviderPluginChoice }, { resolvePluginProviders }] = await Promise.all([
    import("../plugins/provider-wizard.js"),
    import("../plugins/providers.js"),
  ]);
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    bundledProviderAllowlistCompat: true,
    bundledProviderVitestCompat: true,
  });
  const pluginResolved = resolveProviderPluginChoice({
    providers,
    choice,
  });
  if (pluginResolved) {
    return pluginResolved.provider.id;
  }

  const preferred = PREFERRED_PROVIDER_BY_AUTH_CHOICE[choice];
  if (preferred) {
    return preferred;
  }
  return undefined;
}
