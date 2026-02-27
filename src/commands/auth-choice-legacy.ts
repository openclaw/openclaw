import type { AuthChoice } from "./onboard-types.js";

export const AUTH_CHOICE_LEGACY_ALIASES_FOR_CLI: ReadonlyArray<AuthChoice> = [
  "setup-token",
  "oauth",
  "minimax-cloud",
  "minimax",
];

export function normalizeLegacyOnboardAuthChoice(
  authChoice: AuthChoice | undefined,
): AuthChoice | undefined {
  if (authChoice === "oauth") {
    return "setup-token";
  }
  return authChoice;
}

export function isDeprecatedAuthChoice(_authChoice: AuthChoice | undefined): _authChoice is never {
  return false;
}
