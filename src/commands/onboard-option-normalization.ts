import type { AuthChoice, OnboardOptions } from "./onboard-types.js";

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeAuthChoiceInput(value: unknown): AuthChoice | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized as AuthChoice | undefined;
}

export function normalizeOnboardOptionsInput(opts: OnboardOptions): OnboardOptions {
  return {
    ...opts,
    authChoice: normalizeAuthChoiceInput(opts.authChoice),
    tokenProvider: normalizeOptionalString(opts.tokenProvider),
    token: normalizeOptionalString(opts.token),
    tokenProfileId: normalizeOptionalString(opts.tokenProfileId),
    tokenExpiresIn: normalizeOptionalString(opts.tokenExpiresIn),
  };
}
