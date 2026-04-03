/**
 * Sanitize outbound message content to prevent secret values from being
 * transmitted over channel transports.
 *
 * Replaces detected secrets with reference handles before delivery.
 * Named credentials produce `key(<name>)` handles; unknown high-entropy
 * strings produce `[REDACTED:high-entropy]`.
 *
 * This is a defense-in-depth layer: even if a message routes to the wrong
 * recipient, it carries no exploitable value.
 *
 * @see https://github.com/openclaw/openclaw/issues/50718
 */

import type { OpenClawConfig } from "../../config/config.js";

// ---------------------------------------------------------------------------
// Known secret prefixes — deterministic pattern match
// ---------------------------------------------------------------------------

type PrefixRule = {
  prefix: string;
  /** Minimum total length (prefix + token body) to avoid false positives. */
  minLength: number;
};

const SECRET_PREFIX_RULES: PrefixRule[] = [
  { prefix: "ghp_", minLength: 20 },   // GitHub personal access token
  { prefix: "ghr_", minLength: 20 },   // GitHub refresh token
  { prefix: "ghu_", minLength: 20 },   // GitHub user token
  { prefix: "ghs_", minLength: 20 },   // GitHub server token
  { prefix: "github_pat_", minLength: 30 }, // GitHub fine-grained PAT
  { prefix: "sk-ant-", minLength: 30 }, // Anthropic API key
  { prefix: "sk-proj-", minLength: 30 }, // OpenAI project key
  { prefix: "sk-", minLength: 30 },     // Generic OpenAI-style key (after more specific)
  { prefix: "xoxb-", minLength: 20 },   // Slack bot token
  { prefix: "xoxp-", minLength: 20 },   // Slack user token
  { prefix: "xoxa-", minLength: 20 },   // Slack app token
  { prefix: "AKIA", minLength: 20 },    // AWS access key
  { prefix: "lt_", minLength: 30 },     // Leantime API key
];

// ---------------------------------------------------------------------------
// Shannon entropy — catch unknown high-entropy tokens
// ---------------------------------------------------------------------------

function shannonEntropy(str: string): number {
  const freq: Record<string, number> = {};
  for (const ch of str) {
    freq[ch] = (freq[ch] ?? 0) + 1;
  }
  const len = str.length;
  return -Object.values(freq).reduce((acc, count) => {
    const p = count / len;
    return acc + p * Math.log2(p);
  }, 0);
}

/**
 * Returns true when the string looks like a high-entropy secret token:
 * long enough to be a token, alphanumeric-ish, and high entropy.
 */
function isHighEntropyToken(token: string): boolean {
  if (token.length < 20) return false;
  // Must be mostly alphanumeric + a few symbol chars (not natural language)
  const alphanumRatio = (token.match(/[a-zA-Z0-9]/g)?.length ?? 0) / token.length;
  if (alphanumRatio < 0.8) return false;
  return shannonEntropy(token) > 3.5;
}

// ---------------------------------------------------------------------------
// Named credential index — match configured credential values to names
// ---------------------------------------------------------------------------

export type CredentialIndex = Map<string, string>; // value → name

/**
 * Build an index of known credential values from the gateway config.
 * Only includes values long enough (≥16 chars) to be worth matching.
 */
export function buildCredentialIndex(cfg: OpenClawConfig): CredentialIndex {
  const index: CredentialIndex = new Map();

  // Auth tokens
  const auth = cfg.auth as Record<string, unknown> | undefined;
  if (auth) {
    for (const [provider, providerCfg] of Object.entries(auth)) {
      if (typeof providerCfg === "object" && providerCfg !== null) {
        for (const [key, value] of Object.entries(providerCfg as Record<string, unknown>)) {
          if (typeof value === "string" && value.length >= 16) {
            index.set(value, `${provider}:${key}`);
          }
        }
      }
    }
  }

  // Channel configs (tokens, webhooks, etc.)
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (channels) {
    for (const [channelId, channelCfg] of Object.entries(channels)) {
      if (typeof channelCfg === "object" && channelCfg !== null) {
        for (const [key, value] of Object.entries(channelCfg as Record<string, unknown>)) {
          if (typeof value === "string" && value.length >= 16) {
            index.set(value, `${channelId}:${key}`);
          }
        }
      }
    }
  }

  return index;
}

// ---------------------------------------------------------------------------
// Reference handle generation
// ---------------------------------------------------------------------------

/**
 * Returns `key(<name>)` for a named credential, or `[REDACTED:high-entropy]`
 * for an unknown high-entropy token.
 */
function toReferenceHandle(value: string, credIndex: CredentialIndex): string {
  const name = credIndex.get(value);
  if (name) {
    return `key(${name})`;
  }
  // Try prefix match for well-known formats
  for (const rule of SECRET_PREFIX_RULES) {
    if (value.startsWith(rule.prefix) && value.length >= rule.minLength) {
      // Known format but not in index — use prefix as hint
      return `key(${rule.prefix.replace(/_$/, "").replace(/-$/, "")}...)`;
    }
  }
  return "[REDACTED:high-entropy]";
}

// ---------------------------------------------------------------------------
// Token-level scanner
// ---------------------------------------------------------------------------

/**
 * Word-boundary aware tokenizer. Splits on whitespace and common delimiters
 * while preserving the surrounding structure for reconstruction.
 */
function tokenize(text: string): Array<{ token: string; sep: string }> {
  const result: Array<{ token: string; sep: string }> = [];
  // Split on whitespace and common delimiters including '=' so that
  // key=value pairs like `TOKEN=ghp_abc123` surface the value as a token.
  const re = /([^\s,;|=]+)([\s,;|=]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    result.push({ token: m[1], sep: m[2] });
  }
  return result;
}

function isSecretToken(token: string, credIndex: CredentialIndex): boolean {
  // Named credential exact match
  if (credIndex.has(token)) return true;
  // Known prefix match
  for (const rule of SECRET_PREFIX_RULES) {
    if (token.startsWith(rule.prefix) && token.length >= rule.minLength) return true;
  }
  // High-entropy fallback
  return isHighEntropyToken(token);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type SecretSanitizationResult = {
  text: string;
  redacted: boolean;
  count: number;
};

/**
 * Scan `text` for secret values and replace them with reference handles.
 *
 * @param text    Raw outbound message text
 * @param credIndex  Named credential index built from gateway config
 * @returns Sanitized text and metadata
 */
export function sanitizeSecrets(
  text: string,
  credIndex: CredentialIndex,
): SecretSanitizationResult {
  const tokens = tokenize(text);
  let count = 0;
  const parts: string[] = [];

  for (const { token, sep } of tokens) {
    if (isSecretToken(token, credIndex)) {
      parts.push(toReferenceHandle(token, credIndex));
      count++;
    } else {
      parts.push(token);
    }
    parts.push(sep);
  }

  const sanitized = parts.join("");
  return {
    text: sanitized,
    redacted: count > 0,
    count,
  };
}

/**
 * Returns true when secret sanitization is enabled for this config.
 * Default: true (secure by default).
 */
export function isSecretSanitizationEnabled(cfg: OpenClawConfig): boolean {
  const messages = cfg.messages as Record<string, unknown> | undefined;
  if (messages && "sanitizeSecrets" in messages) {
    return messages.sanitizeSecrets !== false;
  }
  return true;
}
