/**
 * Output-side secret scanning.
 *
 * Detects credentials and secrets in text before they are sent to external
 * channels. Supports prefix-specific patterns for common providers.
 *
 * Addresses: T-EXFIL-003 (P0), R-003 (P0)
 */

export type SecretType =
  | "aws-access-key"
  | "github-pat"
  | "github-pat-fine"
  | "openai-key"
  | "anthropic-key"
  | "slack-token"
  | "private-key"
  | "generic-api-key"
  | "generic-secret";

export type SecretMatch = {
  type: SecretType;
  index: number;
  length: number;
  /** First 4 chars + "..." for logging without leaking the full value */
  preview: string;
};

export type SecretScanResult = {
  found: boolean;
  matches: SecretMatch[];
};

type SecretPattern = {
  type: SecretType;
  regex: RegExp;
};

/**
 * Prefix-specific patterns for known credential formats.
 * Each pattern is designed to minimize false positives by matching
 * specific prefixes and expected character classes.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // AWS access key IDs (always start with AKIA)
  { type: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },

  // GitHub personal access tokens (classic)
  { type: "github-pat", regex: /\bghp_[A-Za-z0-9]{36}\b/g },

  // GitHub fine-grained personal access tokens
  { type: "github-pat-fine", regex: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },

  // OpenAI API keys
  { type: "openai-key", regex: /\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}\b/g },

  // Anthropic API keys
  { type: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/g },

  // Slack tokens (bot, user, workspace, app)
  { type: "slack-token", regex: /\bxox[bpors]-[A-Za-z0-9-]{10,255}\b/g },

  // Private key headers (PEM format)
  {
    type: "private-key",
    regex: /-----BEGIN\s+(RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
  },

  // Generic api_key= assignments (catches most config leaks)
  {
    type: "generic-api-key",
    regex: /\b(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-/.]{20,}["']?/gi,
  },

  // Generic secret/password/token assignments
  {
    type: "generic-secret",
    regex: /\b(?:secret|password|token|credential)\s*[:=]\s*["']?[A-Za-z0-9_\-/.+]{16,}["']?/gi,
  },
];

/**
 * Scan text for potential secrets and credentials.
 */
export function scanForSecrets(text: string): SecretScanResult {
  const matches: SecretMatch[] = [];

  for (const { type, regex } of SECRET_PATTERNS) {
    const cloned = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = cloned.exec(text)) !== null) {
      const value = match[0];
      matches.push({
        type,
        index: match.index,
        length: value.length,
        preview: value.slice(0, 4) + "...",
      });
    }
  }

  // Deduplicate overlapping matches (keep the one with the longest match)
  matches.sort((a, b) => a.index - b.index || b.length - a.length);
  const deduped: SecretMatch[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.index >= lastEnd) {
      deduped.push(m);
      lastEnd = m.index + m.length;
    }
  }

  return {
    found: deduped.length > 0,
    matches: deduped,
  };
}

/**
 * Redact detected secrets in text, replacing them with [REDACTED:<type>].
 */
export function redactSecrets(text: string): string {
  const { matches } = scanForSecrets(text);
  if (matches.length === 0) {
    return text;
  }

  // Replace from end to start to preserve indices
  let result = text;
  const reversed = [...matches].toSorted((a, b) => b.index - a.index);
  for (const m of reversed) {
    result = result.slice(0, m.index) + `[REDACTED:${m.type}]` + result.slice(m.index + m.length);
  }

  return result;
}
