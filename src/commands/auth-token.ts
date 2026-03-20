import { normalizeProviderId } from "../agents/model-selection.js";

export const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
/** Anthropic changed token format ~2026; new tokens lack the sk-ant-oat01- prefix. */
export const ANTHROPIC_SETUP_TOKEN_MIN_LENGTH = 40;
export const DEFAULT_TOKEN_PROFILE_NAME = "default";

export function normalizeTokenProfileName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_TOKEN_PROFILE_NAME;
  }
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || DEFAULT_TOKEN_PROFILE_NAME;
}

export function buildTokenProfileId(params: { provider: string; name: string }): string {
  const provider = normalizeProviderId(params.provider);
  const name = normalizeTokenProfileName(params.name);
  return `${provider}:${name}`;
}

export function validateAnthropicSetupToken(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "Required";
  }
  // Accept both legacy sk-ant-oat01- tokens and new-format tokens (Anthropic changed format ~2026).
  if (
    !trimmed.startsWith(ANTHROPIC_SETUP_TOKEN_PREFIX) &&
    trimmed.length < ANTHROPIC_SETUP_TOKEN_MIN_LENGTH
  ) {
    return `Token looks too short; paste the full setup-token`;
  }
  return undefined;
}
