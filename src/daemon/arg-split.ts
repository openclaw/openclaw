export type ArgSplitEscapeMode = "none" | "backslash" | "backslash-quote-only";

export function splitArgsPreservingQuotes(
  value: string,
  options?: { escapeMode?: ArgSplitEscapeMode },
): string[] {
  const args: string[] = [];
  let current = "";
  let tokenStarted = false;
  let inQuotes = false;
  const escapeMode = options?.escapeMode ?? "none";

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escapeMode === "backslash" && char === "\\") {
      if (i + 1 < value.length) {
        current += value[i + 1];
        tokenStarted = true;
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
      current += '"';
      tokenStarted = true;
      i++;
      continue;
    }
    if (char === '"') {
      tokenStarted = true;
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (tokenStarted) {
    args.push(current);
  }
  return args;
}
