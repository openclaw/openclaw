/**
 * API Token types
 */

export type TokenScope =
  | "agent:read"
  | "agent:write"
  | "config:read"
  | "config:write"
  | "audit:read"
  | "sessions:read"
  | "sessions:write"
  | "*";

export interface PersonalAccessToken {
  /** Token ID (UUIDv7) */
  id: string;
  /** User-friendly name */
  name: string;
  /** First 8 chars for display (e.g., "clb_abc1") */
  prefix: string;
  /** SHA-256 hash of full token (full token never stored) */
  hashedToken: string;
  /** Granted scopes */
  scopes: TokenScope[];
  /** Unix timestamp when created */
  createdAt: number;
  /** Unix timestamp when expires, null = never */
  expiresAt: number | null;
  /** Unix timestamp when last used */
  lastUsedAt: number | null;
  /** Unix timestamp when revoked, null = active */
  revokedAt: number | null;
}

export interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface TokenCreationResult {
  token: TokenInfo;
  fullToken: string;
}

export const TOKEN_PREFIX = "clb_";
export const TOKEN_PREFIX_DISPLAY_LENGTH = 8;
export const MAX_TOKEN_EXPIRY_DAYS = 365;
