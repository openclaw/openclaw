/**
 * Outbound message credential scanning.
 *
 * Detects and redacts credential-like values in text before it's
 * delivered to messaging channels. Prevents the agent from accidentally
 * (or via prompt injection) leaking API keys, tokens, or passwords
 * in its chat responses.
 *
 * Uses the same token-prefix patterns as src/logging/redact.ts but
 * applied to outbound message content rather than log lines.
 */

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{20,})\b/,
  /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/,
  /\b(ghp_[A-Za-z0-9]{20,})\b/,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  /\b(xapp-[A-Za-z0-9-]{10,})\b/,
  /\b(gsk_[A-Za-z0-9_-]{10,})\b/,
  /\b(AIza[0-9A-Za-z\-_]{20,})\b/,
  /\b(pplx-[A-Za-z0-9_-]{10,})\b/,
  /\b(npm_[A-Za-z0-9]{10,})\b/,
  /\b(\d{6,}:[A-Za-z0-9_-]{20,})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export interface OutboundScanResult {
  containsCredentials: boolean;
  detectedPatterns: string[];
  redactedText: string;
}

export function scanOutboundForCredentials(text: string): OutboundScanResult {
  if (!text) {
    return { containsCredentials: false, detectedPatterns: [], redactedText: text };
  }

  const detectedPatterns: string[] = [];
  let redacted = text;

  for (const pattern of CREDENTIAL_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
    if (globalPattern.test(redacted)) {
      detectedPatterns.push(pattern.source);
      globalPattern.lastIndex = 0;
      redacted = redacted.replace(globalPattern, (match) => {
        const keep = Math.min(6, Math.floor(match.length / 4));
        return `${match.slice(0, keep)}${"*".repeat(Math.max(4, match.length - keep * 2))}${match.slice(-keep || undefined)}`;
      });
    }
  }

  return {
    containsCredentials: detectedPatterns.length > 0,
    detectedPatterns,
    redactedText: redacted,
  };
}
