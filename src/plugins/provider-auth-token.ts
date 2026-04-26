import { normalizeProviderId } from "../agents/provider-id.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
// Standard long-lived Anthropic API key prefix. Both prefixes are valid
// `paste-token` inputs for the `anthropic` provider — sk-ant-oat01- for
// OAuth setup tokens, sk-ant-api03- for direct API keys. Without this the
// CLI rejects valid API keys with "Expected token starting with
// sk-ant-oat01-". (#72121)
export const ANTHROPIC_API_KEY_PREFIX = "sk-ant-api03-";
export const ANTHROPIC_SETUP_TOKEN_MIN_LENGTH = 80;
export const ANTHROPIC_TOKEN_PREFIXES = [
  ANTHROPIC_SETUP_TOKEN_PREFIX,
  ANTHROPIC_API_KEY_PREFIX,
] as const;
export const DEFAULT_TOKEN_PROFILE_NAME = "default";

export function normalizeTokenProfileName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_TOKEN_PROFILE_NAME;
  }
  const slug = normalizeLowercaseStringOrEmpty(trimmed)
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
  const matchedPrefix = ANTHROPIC_TOKEN_PREFIXES.find((prefix) => trimmed.startsWith(prefix));
  if (!matchedPrefix) {
    return `Expected token starting with ${ANTHROPIC_TOKEN_PREFIXES.join(" or ")}`;
  }
  if (trimmed.length < ANTHROPIC_SETUP_TOKEN_MIN_LENGTH) {
    return matchedPrefix === ANTHROPIC_SETUP_TOKEN_PREFIX
      ? "Token looks too short; paste the full setup-token"
      : "Token looks too short; paste the full API key";
  }
  return undefined;
}
