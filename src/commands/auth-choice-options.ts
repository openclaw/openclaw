import type { AuthProfileStore } from "../agents/auth-profiles.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
} from "../agents/auth-profiles.js";
import type { AuthChoice } from "./onboard-types.js";

export type AuthChoiceOption = { value: AuthChoice; label: string };

export function buildAuthChoiceOptions(params: {
  store: AuthProfileStore;
  includeSkip: boolean;
}): AuthChoiceOption[] {
  const options: AuthChoiceOption[] = [];

  const claudeCli = params.store.profiles[CLAUDE_CLI_PROFILE_ID];
  if (claudeCli?.type === "oauth") {
    options.push({
      value: "claude-cli",
      label: "Anthropic OAuth (Claude CLI)",
    });
  }

  options.push({ value: "oauth", label: "Anthropic OAuth (Claude Pro/Max)" });

  const codexCli = params.store.profiles[CODEX_CLI_PROFILE_ID];
  if (codexCli?.type === "oauth") {
    options.push({
      value: "codex-cli",
      label: "OpenAI Codex OAuth (Codex CLI)",
    });
  }

  options.push({
    value: "openai-codex",
    label: "OpenAI Codex (ChatGPT OAuth)",
  });
  options.push({
    value: "antigravity",
    label: "Google Antigravity (Claude Opus 4.5, Gemini 3, etc.)",
  });
  options.push({ value: "apiKey", label: "Anthropic API key" });
  options.push({ value: "minimax", label: "Minimax M2.1 (LM Studio)" });
  if (params.includeSkip) {
    options.push({ value: "skip", label: "Skip for now" });
  }

  return options;
}
