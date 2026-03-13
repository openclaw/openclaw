import { isSafeExecutableValue } from "../infra/exec-safety.js";

export type ArgSplitEscapeMode = "none" | "backslash" | "backslash-quote-only";

export function splitArgsPreservingQuotes(
  value: string,
  options?: { escapeMode?: ArgSplitEscapeMode },
): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  const escapeMode = options?.escapeMode ?? "none";

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escapeMode === "backslash" && char === "\\") {
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
      current += '"';
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    args.push(current);
  }
  return args;
}

/**
 * Validate that the command (first element) of a parsed argv is a safe
 * executable value. This prevents using splitArgsPreservingQuotes output
 * as a trusted command without validation (CWE-78).
 */
export function assertSafeArgv(argv: string[]): void {
  if (argv.length === 0) {
    return;
  }
  if (!isSafeExecutableValue(argv[0])) {
    throw new Error(`Parsed command is not a safe executable value: ${argv[0]}`);
  }
}
