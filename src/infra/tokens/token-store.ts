/**
 * Token storage and management
 */

import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PersonalAccessToken, TokenInfo, TokenCreationResult, TokenScope } from "./types.js";
import { TOKEN_PREFIX, TOKEN_PREFIX_DISPLAY_LENGTH } from "./types.js";

/** Directory for security data */
const SECURITY_DIR = ".clawdbrain/security";

/** Tokens file name */
const TOKENS_FILE = "tokens.json";

/**
 * Resolve the tokens file path.
 */
export function resolveTokensPath(homeDir: string): string {
  return join(homeDir, SECURITY_DIR, TOKENS_FILE);
}

/**
 * Load tokens from file.
 */
export async function loadTokens(tokensPath: string): Promise<PersonalAccessToken[]> {
  try {
    const content = await readFile(tokensPath, "utf-8");
    const data = JSON.parse(content);

    if (!Array.isArray(data)) {
      return [];
    }

    return data as PersonalAccessToken[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    console.error("Failed to load tokens:", error);
    return [];
  }
}

/**
 * Save tokens to file.
 */
export async function saveTokens(tokensPath: string, tokens: PersonalAccessToken[]): Promise<void> {
  await mkdir(dirname(tokensPath), { recursive: true });
  await writeFile(tokensPath, JSON.stringify(tokens, null, 2), "utf-8");
}

/**
 * Generate a secure random token.
 */
function generateToken(): string {
  // Generate 32 bytes of random data (256 bits)
  const randomBytes = crypto.randomBytes(32);
  // Encode as base64url
  const token = randomBytes.toString("base64url");
  return `${TOKEN_PREFIX}${token}`;
}

/**
 * Hash a token for storage.
 */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Extract token prefix for display.
 */
function getTokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + TOKEN_PREFIX_DISPLAY_LENGTH);
}

/**
 * Create a new API token.
 */
export async function createToken(
  homeDir: string,
  params: {
    name: string;
    scopes: TokenScope[];
    expiresInDays?: number | null;
  },
): Promise<TokenCreationResult> {
  const tokensPath = resolveTokensPath(homeDir);
  const tokens = await loadTokens(tokensPath);

  // Generate token
  const fullToken = generateToken();
  const hashedToken = hashToken(fullToken);
  const prefix = getTokenPrefix(fullToken);

  const now = Date.now();
  const expiresAt = params.expiresInDays ? now + params.expiresInDays * 24 * 60 * 60 * 1000 : null;

  const newToken: PersonalAccessToken = {
    id: crypto.randomUUID(),
    name: params.name,
    prefix,
    hashedToken,
    scopes: params.scopes,
    createdAt: now,
    expiresAt,
    lastUsedAt: null,
    revokedAt: null,
  };

  tokens.push(newToken);
  await saveTokens(tokensPath, tokens);

  return {
    token: toTokenInfo(newToken),
    fullToken,
  };
}

/**
 * List all tokens.
 */
export async function listTokens(homeDir: string): Promise<TokenInfo[]> {
  const tokensPath = resolveTokensPath(homeDir);
  const tokens = await loadTokens(tokensPath);

  return tokens.map(toTokenInfo);
}

/**
 * Revoke a token.
 */
export async function revokeToken(homeDir: string, tokenId: string): Promise<{ success: boolean }> {
  const tokensPath = resolveTokensPath(homeDir);
  const tokens = await loadTokens(tokensPath);

  const tokenIndex = tokens.findIndex((t) => t.id === tokenId);
  if (tokenIndex === -1) {
    return { success: false };
  }

  tokens[tokenIndex].revokedAt = Date.now();
  await saveTokens(tokensPath, tokens);

  return { success: true };
}

/**
 * Verify a token and return its info if valid.
 */
export async function verifyToken(
  homeDir: string,
  token: string,
): Promise<{ valid: boolean; token?: TokenInfo; scopes?: TokenScope[] }> {
  const tokensPath = resolveTokensPath(homeDir);
  const tokens = await loadTokens(tokensPath);

  const hashedInput = hashToken(token);
  const now = Date.now();

  const found = tokens.find(
    (t) => t.hashedToken === hashedInput && !t.revokedAt && (!t.expiresAt || t.expiresAt > now),
  );

  if (!found) {
    return { valid: false };
  }

  // Update last used timestamp
  found.lastUsedAt = now;
  await saveTokens(tokensPath, tokens);

  return {
    valid: true,
    token: toTokenInfo(found),
    scopes: found.scopes,
  };
}

/**
 * Check if a token has a specific scope.
 */
export function hasScope(scopes: TokenScope[], required: TokenScope): boolean {
  if (scopes.includes("*")) return true;
  return scopes.includes(required);
}

/**
 * Convert PersonalAccessToken to TokenInfo (without sensitive data).
 */
function toTokenInfo(token: PersonalAccessToken): TokenInfo {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    scopes: token.scopes,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
    revokedAt: token.revokedAt,
  };
}
