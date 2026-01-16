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
  "ai-gateway-api-key": "vercel-ai-gateway",
  "moonshot-api-key": "moonshot",
  "gemini-api-key": "google",
  "zai-api-key": "zai",
  antigravity: "google-antigravity",
  "synthetic-api-key": "synthetic",
  "github-copilot": "github-copilot",
  "minimax-cloud": "minimax",
  "minimax-api": "minimax",
  "minimax-api-lightning": "minimax",
  minimax: "lmstudio",
  "opencode-zen": "opencode",
};

export function resolvePreferredProviderForAuthChoice(choice: AuthChoice): string | undefined {
  return PREFERRED_PROVIDER_BY_AUTH_CHOICE[choice];
}
