import { normalizeProviderId } from "../agents/model-selection.js";

export const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
export const ANTHROPIC_SETUP_TOKEN_MIN_LENGTH = 80;
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

/**
 * Strip all whitespace (including newlines) from a pasted token.
 * `claude setup-token` may output tokens that wrap across lines,
 * and terminal paste can introduce newlines that silently truncate the value.
 */
export function normalizeSetupToken(raw: string): string {
  return raw.replace(/\s+/g, "");
}

export function validateAnthropicSetupToken(raw: string): string | undefined {
  const normalized = normalizeSetupToken(raw);
  if (!normalized) {
    return "Required";
  }
  if (!normalized.startsWith(ANTHROPIC_SETUP_TOKEN_PREFIX)) {
    return `Expected token starting with ${ANTHROPIC_SETUP_TOKEN_PREFIX}`;
  }
  if (normalized.length < ANTHROPIC_SETUP_TOKEN_MIN_LENGTH) {
    return "Token looks too short; paste the full setup-token";
  }
  return undefined;
}
