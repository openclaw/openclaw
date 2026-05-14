const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu],
  ["phone", /\+?\d[\d\s().-]{7,}\d/gu],
  ["bearer", /\bBearer\s+[A-Za-z0-9._-]+\b/giu],
  ["api_key", /\b(?:sk|pk|api|key|token)[A-Za-z0-9_-]{10,}\b/giu],
  ["private_key", /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gu],
  ["password", /\bpassword\s*[:=]\s*["']?[^"'\s]+["']?/giu],
  ["url_token", /https?:\/\/[^\s]+(?:token|sig|signature|key|auth)=[^\s&]+[^\s]*/giu],
];

export type MaskSecretsResult = {
  maskedText: string;
  replacements: Array<{ kind: string; count: number }>;
};

export function maskSensitiveText(input: string): MaskSecretsResult {
  let maskedText = input;
  const replacements: Array<{ kind: string; count: number }> = [];
  for (const [kind, pattern] of SECRET_PATTERNS) {
    let count = 0;
    maskedText = maskedText.replace(pattern, () => {
      count += 1;
      return `[REDACTED_${kind.toUpperCase()}]`;
    });
    if (count > 0) {
      replacements.push({ kind, count });
    }
  }
  return { maskedText, replacements };
}
