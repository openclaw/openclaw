import type { OpenClawConfig } from "../config/config.js";
import { resolveProviderPluginChoice } from "../plugins/provider-wizard.js";
import { resolvePluginProviders } from "../plugins/providers.js";
import type { AuthChoice } from "./onboard-types.js";

const PREFERRED_PROVIDER_BY_AUTH_CHOICE: Partial<Record<AuthChoice, string>> = {
  oauth: "anthropic",
  "setup-token": "anthropic",
  "claude-cli": "anthropic",
  token: "anthropic",
  apiKey: "anthropic",
  "openai-codex": "openai-codex",
  "codex-cli": "openai-codex",
  chutes: "chutes",
  "openai-api-key": "openai",
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

export function resolvePreferredProviderForAuthChoice(params: {
  choice: AuthChoice;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const preferred = PREFERRED_PROVIDER_BY_AUTH_CHOICE[params.choice];
  if (preferred) {
    return preferred;
  }

  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return resolveProviderPluginChoice({
    providers,
    choice: params.choice,
  })?.provider.id;
}
