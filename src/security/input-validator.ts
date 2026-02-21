/**
 * Input validation layers for inbound messages.
 *
 * Provides token length limits, Unicode homoglyph folding for all inbound
 * messages, and excessive repetition detection.
 *
 * Addresses: T-EXEC-001 (P0), T-IMPACT-002 (P1)
 */

export type InputValidationResult = {
  valid: boolean;
  warnings: InputValidationWarning[];
  /** Normalized content with homoglyphs folded */
  normalizedContent: string;
  /** Whether the content was truncated */
  truncated: boolean;
};

export type InputValidationWarning = {
  code:
    | "token-limit-exceeded"
    | "homoglyph-detected"
    | "excessive-repetition"
    | "suspicious-unicode";
  message: string;
};

export type InputValidatorOptions = {
  /** Maximum token count (approximated as chars / 4). Default: 100000 */
  maxTokens?: number;
  /** Repetition threshold: max times a 10+ char substring can repeat. Default: 50 */
  maxRepetitions?: number;
};

const DEFAULT_MAX_TOKENS = 100_000;
const DEFAULT_MAX_REPETITIONS = 50;
const CHARS_PER_TOKEN_APPROX = 4;

// Fullwidth ASCII range
const FULLWIDTH_ASCII_OFFSET = 0xfee0;

// Map of Unicode angle bracket homoglyphs to their ASCII equivalents
const ANGLE_BRACKET_MAP: Record<number, string> = {
  0xff1c: "<", // fullwidth <
  0xff1e: ">", // fullwidth >
  0x2329: "<", // left-pointing angle bracket
  0x232a: ">", // right-pointing angle bracket
  0x3008: "<", // CJK left angle bracket
  0x3009: ">", // CJK right angle bracket
  0x2039: "<", // single left-pointing angle quotation mark
  0x203a: ">", // single right-pointing angle quotation mark
  0x27e8: "<", // mathematical left angle bracket
  0x27e9: ">", // mathematical right angle bracket
  0xfe64: "<", // small less-than sign
  0xfe65: ">", // small greater-than sign
};

// Common confusable characters (Cyrillic, Greek lookalikes for Latin)
const CONFUSABLES: Record<number, string> = {
  0x0410: "A", // Cyrillic А
  0x0412: "B", // Cyrillic В
  0x0421: "C", // Cyrillic С
  0x0415: "E", // Cyrillic Е
  0x041d: "H", // Cyrillic Н
  0x041a: "K", // Cyrillic К
  0x041c: "M", // Cyrillic М
  0x041e: "O", // Cyrillic О
  0x0420: "P", // Cyrillic Р
  0x0422: "T", // Cyrillic Т
  0x0425: "X", // Cyrillic Х
  0x0430: "a", // Cyrillic а
  0x0435: "e", // Cyrillic е
  0x043e: "o", // Cyrillic о
  0x0440: "p", // Cyrillic р
  0x0441: "c", // Cyrillic с
  0x0443: "y", // Cyrillic у
  0x0445: "x", // Cyrillic х
};

const HOMOGLYPH_REGEX =
  /[\uFF21-\uFF3A\uFF41-\uFF5A\uFF1C\uFF1E\u2329\u232A\u3008\u3009\u2039\u203A\u27E8\u27E9\uFE64\uFE65\u0410\u0412\u0421\u0415\u041D\u041A\u041C\u041E\u0420\u0422\u0425\u0430\u0435\u043E\u0440\u0441\u0443\u0445]/g;

function foldHomoglyph(char: string): string {
  const code = char.charCodeAt(0);

  // Fullwidth letters → ASCII
  if (code >= 0xff21 && code <= 0xff3a) {
    return String.fromCharCode(code - FULLWIDTH_ASCII_OFFSET);
  }
  if (code >= 0xff41 && code <= 0xff5a) {
    return String.fromCharCode(code - FULLWIDTH_ASCII_OFFSET);
  }

  // Angle brackets
  const bracket = ANGLE_BRACKET_MAP[code];
  if (bracket) {
    return bracket;
  }

  // Confusable characters
  const confusable = CONFUSABLES[code];
  if (confusable) {
    return confusable;
  }

  return char;
}

/**
 * Fold Unicode homoglyphs to their ASCII equivalents.
 * Extends the existing external-content.ts folding to cover more confusable characters.
 */
export function foldHomoglyphs(input: string): string {
  return input.replace(HOMOGLYPH_REGEX, foldHomoglyph);
}

/**
 * Detect excessive repetition patterns (common in jailbreak/resource exhaustion attacks).
 * Returns the count of repeated substrings found.
 */
export function detectRepetition(
  content: string,
  maxRepetitions = DEFAULT_MAX_REPETITIONS,
): number {
  // Check for any 10+ char substring repeated excessively
  if (content.length < 20) {
    return 0;
  }

  // Sample a few positions to check for repetition
  const sampleSize = Math.min(10, Math.floor(content.length / 20));
  let maxFound = 0;

  for (let i = 0; i < sampleSize; i++) {
    const start = Math.floor((i / sampleSize) * (content.length - 10));
    const substr = content.slice(start, start + 10);
    if (!substr.trim()) {
      continue;
    }
    // Escape regex special characters
    const escaped = substr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      const regex = new RegExp(escaped, "g");
      let count = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        if (match[0].length === 0) {
          regex.lastIndex++; // Prevent infinite loop on zero-length match
          continue; // Skip counting zero-length matches
        }
        count++;
        if (count > maxRepetitions) {
          break;
        }
      }
      maxFound = Math.max(maxFound, count);
    } catch {
      continue;
    }
  }

  return maxFound;
}

/**
 * Validate inbound content for safety.
 */
export function validateInput(
  content: string,
  options?: InputValidatorOptions,
): InputValidationResult {
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxRepetitions = options?.maxRepetitions ?? DEFAULT_MAX_REPETITIONS;
  const warnings: InputValidationWarning[] = [];
  let normalizedContent = content;
  let truncated = false;

  // 1. Token length check
  const estimatedTokens = Math.ceil(content.length / CHARS_PER_TOKEN_APPROX);
  if (estimatedTokens > maxTokens) {
    warnings.push({
      code: "token-limit-exceeded",
      message: `Content exceeds token limit (estimated ${estimatedTokens} tokens, max ${maxTokens})`,
    });
    const maxChars = maxTokens * CHARS_PER_TOKEN_APPROX;
    normalizedContent = content.slice(0, maxChars);
    truncated = true;
  }

  // 2. Homoglyph detection and folding (use a local regex to avoid g-flag state issues)
  if (
    /[\uFF21-\uFF3A\uFF41-\uFF5A\uFF1C\uFF1E\u2329\u232A\u3008\u3009\u2039\u203A\u27E8\u27E9\uFE64\uFE65\u0410\u0412\u0421\u0415\u041D\u041A\u041C\u041E\u0420\u0422\u0425\u0430\u0435\u043E\u0440\u0441\u0443\u0445]/.test(
      normalizedContent,
    )
  ) {
    warnings.push({
      code: "homoglyph-detected",
      message: "Unicode homoglyphs detected and normalized",
    });
    normalizedContent = foldHomoglyphs(normalizedContent);
  }

  // 3. Excessive repetition detection
  const repetitionCount = detectRepetition(normalizedContent, maxRepetitions);
  if (repetitionCount > maxRepetitions) {
    warnings.push({
      code: "excessive-repetition",
      message: `Excessive repetition detected (${repetitionCount} repeats, threshold ${maxRepetitions})`,
    });
  }

  return {
    valid: warnings.length === 0,
    warnings,
    normalizedContent,
    truncated,
  };
}
