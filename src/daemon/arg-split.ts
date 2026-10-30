type ArgSplitEscapeMode = "none" | "backslash" | "backslash-quote-only";
type ArgSplitQuoteChar = '"' | "'";
type ArgSplitQuoteStart = "anywhere" | "item-start";

/** Splits service command strings while preserving quoted arguments across platform parsers. */
export function splitArgsPreservingQuotes(
  value: string,
  options?: {
    escapeMode?: ArgSplitEscapeMode;
    quoteChars?: readonly ArgSplitQuoteChar[];
    quoteStart?: ArgSplitQuoteStart;
  },
): string[] {
  const args: string[] = [];
  let current: string | null = null;
  let quoteChar: ArgSplitQuoteChar | null = null;
  const escapeMode = options?.escapeMode ?? "none";
  const quoteChars = new Set<ArgSplitQuoteChar>(options?.quoteChars ?? ['"']);
  const quoteStart = options?.quoteStart ?? "anywhere";

  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);
    if (
      char === "\\" &&
      (escapeMode === "backslash" ||
        (escapeMode === "backslash-quote-only" && value[i + 1] === '"'))
    ) {
      // POSIX consumes every escape; Windows only consumes inserted quotes, keeping path slashes.
      if (i + 1 < value.length) {
        current = (current ?? "") + value[i + 1];
        i++;
      }
      continue;
    }
    if (quoteChars.has(char as ArgSplitQuoteChar)) {
      if (quoteChar === char) {
        quoteChar = null;
        continue;
      }
      if (!quoteChar && (quoteStart === "anywhere" || !current)) {
        quoteChar = char as ArgSplitQuoteChar;
        current ??= "";
        continue;
      }
    }
    if (!quoteChar && /\s/.test(char)) {
      if (current !== null) {
        args.push(current);
        current = null;
      }
      continue;
    }
    current = (current ?? "") + char;
  }
  if (current !== null) {
    args.push(current);
  }
  return args;
}
