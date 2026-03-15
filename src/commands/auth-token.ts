import { normalizeProviderId } from "../agents/model-selection.js";

export const ANTHROPIC_SETUP_TOKEN_PREFIXES = ["sk-ant-oat01-", "sk-ant-api03-"];
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

export function validateAnthropicSetupToken(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "Required";
  }
  if (!ANTHROPIC_SETUP_TOKEN_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return `Expected token starting with ${ANTHROPIC_SETUP_TOKEN_PREFIXES.join(" or ")}`;
  }
  if (trimmed.length < ANTHROPIC_SETUP_TOKEN_MIN_LENGTH) {
    return "Token looks too short; paste the full setup-token";
  }
  return undefined;
}
