import type { AuthChoice } from "./onboard-types.js";

export const AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI: ReadonlyArray<AuthChoice> = [
  "setup-token",
  "oauth",
  "claude-cli",
  "codex-cli",
  "minimax-cloud",
  "minimax",
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
