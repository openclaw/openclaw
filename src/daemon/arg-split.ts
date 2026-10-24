/** Shared argument splitter for service command lines rendered by platform adapters. */
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
  let current = "";
  // Tracks whether the current token exists, including empty quoted args (`""`).
  let argStarted = false;
  let quoteChar: ArgSplitQuoteChar | null = null;
  const escapeMode = options?.escapeMode ?? "none";
  const quoteChars = new Set<ArgSplitQuoteChar>(options?.quoteChars ?? ['"']);
  const quoteStart = options?.quoteStart ?? "anywhere";

  for (let i = 0; i < value.length; i++) {
    const char = value.charAt(i);
    if (escapeMode === "backslash" && char === "\\") {
      // POSIX-style service parsers consume any escaped next byte.
      if (i + 1 < value.length) {
        current += value[i + 1];
        i++;
      }
      continue;
    }
    if (
      escapeMode === "backslash-quote-only" &&
      char === "\\" &&
      i + 1 < value.length &&
      value[i + 1] === '"'
    ) {
      // Windows cmd scripts escape only renderer-inserted quotes here; paths keep
      // their backslashes literal.
      current += '"';
      i++;
      continue;
    }
    if (quoteChars.has(char as ArgSplitQuoteChar)) {
      if (quoteChar === char) {
        quoteChar = null;
        continue;
      }
      const canOpenQuote = quoteStart === "anywhere" || current.length === 0;
      if (!quoteChar && canOpenQuote) {
        quoteChar = char as ArgSplitQuoteChar;
        // An opening quote starts a token even when nothing follows before close.
        argStarted = true;
        continue;
      }
    }
    if (!quoteChar && /\s/.test(char)) {
      if (argStarted) {
        args.push(current);
        current = "";
        argStarted = false;
      }
      continue;
    }
    current += char;
    argStarted = true;
  }
  if (argStarted) {
    args.push(current);
  }
  return args;
}
