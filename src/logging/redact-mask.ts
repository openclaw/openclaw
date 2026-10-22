import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;
const SECRET_VALUE_TRAILING_DELIMITER_RE = /(["'`,;)}\]]+)$/u;
const SECRET_VALUE_SUFFIX_RE = /^["'`,;)}\]]*$/u;
const SECRET_VALUE_QUOTE_CHARS = new Set(['"', "'", "`"]);

export function maskToken(token: string): string {
  if (token.length < DEFAULT_REDACT_MIN_LENGTH) {
    return "***";
  }
  const start = sliceUtf16Safe(token, 0, DEFAULT_REDACT_KEEP_START);
  const end = sliceUtf16Safe(token, -DEFAULT_REDACT_KEEP_END);
  return `${start}…${end}`;
}

export function splitSecretValueForMask(token: string): {
  maskable: string;
  suffix: string;
  maskStart: number;
  maskEnd: number;
} {
  const openingQuote = token[0] ?? "";
  const contentStart = SECRET_VALUE_QUOTE_CHARS.has(openingQuote) ? 1 : 0;
  if (contentStart) {
    const closingQuoteIndex = token.lastIndexOf(openingQuote);
    if (closingQuoteIndex > 0) {
      const suffix = token.slice(closingQuoteIndex + 1);
      if (SECRET_VALUE_SUFFIX_RE.test(suffix)) {
        return {
          maskable: token.slice(1, closingQuoteIndex),
          suffix,
          maskStart: 0,
          maskEnd: closingQuoteIndex + 1,
        };
      }
    }
  }

  const content = token.slice(contentStart);
  const trailingDelimiter = content.match(SECRET_VALUE_TRAILING_DELIMITER_RE)?.[1] ?? "";
  const maskable =
    trailingDelimiter && trailingDelimiter.length < content.length
      ? content.slice(0, -trailingDelimiter.length)
      : content;
  return {
    maskable,
    suffix: maskable === content ? "" : trailingDelimiter,
    maskStart: 0,
    maskEnd: contentStart + maskable.length,
  };
}

export function splitFormAwareCredentialValue(token: string): { secret: string; suffix: string } {
  const pairBoundary = token.search(/&[A-Za-z_][A-Za-z0-9_.-]*=/u);
  return pairBoundary < 0
    ? { secret: token, suffix: "" }
    : { secret: token.slice(0, pairBoundary), suffix: token.slice(pairBoundary) };
}

export function maskSecretValue(token: string, options?: { hinted?: boolean }): string {
  const { maskable, suffix } = splitSecretValueForMask(token);
  return `${options?.hinted ? maskToken(maskable) : "***"}${suffix}`;
}
