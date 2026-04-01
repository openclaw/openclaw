export function estimateBase64DecodedBytes(base64: string): number {
  // Avoid `trim()`/`replace()` here: they allocate a second (potentially huge) string.
  // We only need a conservative decoded-size estimate to enforce budgets before Buffer.from(..., "base64").
  let effectiveLen = 0;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    // Treat ASCII control + space as whitespace; base64 decoders commonly ignore these.
    if (code <= 0x20) {
      continue;
    }
    effectiveLen += 1;
  }

  if (effectiveLen === 0) {
    return 0;
  }

  let padding = 0;
  // Find last non-whitespace char(s) to detect '=' padding without allocating/copying.
  let end = base64.length - 1;
  while (end >= 0 && base64.charCodeAt(end) <= 0x20) {
    end -= 1;
  }
  if (end >= 0 && base64[end] === "=") {
    padding = 1;
    end -= 1;
    while (end >= 0 && base64.charCodeAt(end) <= 0x20) {
      end -= 1;
    }
    if (end >= 0 && base64[end] === "=") {
      padding = 2;
    }
  }

  const estimated = Math.floor((effectiveLen * 3) / 4) - padding;
  return Math.max(0, estimated);
}

const BASE64_CHARS_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Normalize and validate a base64 string.
 * Returns canonical base64 (no whitespace) or undefined when invalid.
 */
export function canonicalizeBase64(base64: string): string | undefined {
  const cleaned = base64.replace(/\s+/g, "");
  if (!cleaned || cleaned.length % 4 !== 0 || !BASE64_CHARS_RE.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}
