import { normalizeProviderId } from "../agents/model-selection.js";

export const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
export const ANTHROPIC_SETUP_TOKEN_MIN_LENGTH = 80;
export const ANTHROPIC_REFRESH_TOKEN_PREFIX = "sk-ant-ort01-";
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
 * Validate an optional Anthropic OAuth refresh token.
 * Returns undefined (valid) if blank (optional) or a valid refresh token.
 */
export function validateAnthropicRefreshToken(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined; // blank is OK (refresh token is optional)
  }
  if (!trimmed.startsWith(ANTHROPIC_REFRESH_TOKEN_PREFIX)) {
    return `Expected refresh token starting with ${ANTHROPIC_REFRESH_TOKEN_PREFIX} (or leave blank)`;
  }
  if (trimmed.length < ANTHROPIC_SETUP_TOKEN_MIN_LENGTH) {
    return "Refresh token looks too short; paste the full token";
  }
  return undefined;
}

/**
 * Try to parse a JSON credentials blob (from ~/.claude/.credentials.json).
 * Returns extracted credentials or null if not valid JSON credentials.
 * The refreshToken and expiresAt fields are null when only an access token is present.
 */
export function tryParseClaudeCredentials(raw: string): {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
} | null {
  try {
    const data = JSON.parse(raw.trim());
    const oauth = data?.claudeAiOauth;
    if (
      oauth &&
      typeof oauth.accessToken === "string" &&
      oauth.accessToken.startsWith(ANTHROPIC_SETUP_TOKEN_PREFIX)
    ) {
      const hasRefresh =
        typeof oauth.refreshToken === "string" &&
        oauth.refreshToken.startsWith(ANTHROPIC_REFRESH_TOKEN_PREFIX);
      return {
        accessToken: oauth.accessToken,
        refreshToken: hasRefresh ? oauth.refreshToken : null,
        expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
      };
    }
  } catch {
    // Not JSON; that is fine
  }
  return null;
}

export function validateAnthropicSetupToken(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "Required";
  }
  // Allow pasting full JSON credentials blob
  if (trimmed.startsWith("{")) {
    const parsed = tryParseClaudeCredentials(trimmed);
    if (parsed) {
      return undefined; // valid JSON credentials
    }
    return "Invalid JSON — expected ~/.claude/.credentials.json contents or a setup-token";
  }
  if (!trimmed.startsWith(ANTHROPIC_SETUP_TOKEN_PREFIX)) {
    return `Expected token starting with ${ANTHROPIC_SETUP_TOKEN_PREFIX}`;
  }
  if (trimmed.length < ANTHROPIC_SETUP_TOKEN_MIN_LENGTH) {
    return "Token looks too short; paste the full setup-token";
  }
  return undefined;
}
