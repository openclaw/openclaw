import type { AuthChoice } from "./onboard-types.js";

export const AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI: ReadonlyArray<AuthChoice> = [
  "setup-token",
  "oauth",
  "claude-cli",
  "codex-cli",
];

export function normalizeLegacyOnboardAuthChoice(
  authChoice: AuthChoice | undefined,
): AuthChoice | undefined {
  if (authChoice === "oauth" || authChoice === "claude-cli") {
    return "setup-token";
  }
  if (authChoice === "codex-cli") {
    return "openai-codex";
  }
  return authChoice;
}

export function isDeprecatedAuthChoice(
  authChoice: AuthChoice | undefined,
): authChoice is "claude-cli" | "codex-cli" {
  return authChoice === "claude-cli" || authChoice === "codex-cli";
}

export function resolveDeprecatedAuthChoiceReplacement(authChoice: "claude-cli" | "codex-cli"): {
  normalized: AuthChoice;
  message: string;
} {
  if (authChoice === "claude-cli") {
    return {
      normalized: "setup-token",
      message: 'Auth choice "claude-cli" is deprecated; using setup-token flow instead.',
    };
  }
  return {
    normalized: "openai-codex",
    message: 'Auth choice "codex-cli" is deprecated; using OpenAI Codex OAuth instead.',
  };
}

export function formatDeprecatedNonInteractiveAuthChoiceError(
  authChoice: "claude-cli" | "codex-cli",
): string {
  const replacement =
    authChoice === "claude-cli"
      ? '"--auth-choice token" (Anthropic setup-token)'
      : '"--auth-choice openai-codex"';
  return [`Auth choice "${authChoice}" is deprecated.`, `Use ${replacement}.`].join("\n");
}
