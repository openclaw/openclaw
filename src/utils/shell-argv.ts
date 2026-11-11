const DOUBLE_QUOTE_ESCAPES = new Set(["\\", '"', "$", "`", "\n", "\r"]);

// POSIX double quotes only consume the backslash before a small escape set;
// preserving other backslashes keeps command-risk analysis byte-faithful.
function isDoubleQuoteEscape(next: string | undefined): next is string {
  return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}

/** Returns whether a shell string contains an unquoted command separator or pipeline operator. */
export function hasTopLevelShellControlOperator(raw: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let wordStart = true;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (escaped) {
      escaped = false;
      wordStart = false;
      continue;
    }
    if (quote) {
      if (quote === '"' && ch === "\\" && isDoubleQuoteEscape(raw[i + 1])) {
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      wordStart = false;
      continue;
    }
    if (ch === "#" && wordStart) {
      return /[\r\n]/u.test(raw.slice(i + 1));
    }
    if (ch === "&" && (raw[i - 1] === ">" || raw[i - 1] === "<")) {
      wordStart = false;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "\r") {
      return true;
    }
    wordStart = /\s/u.test(ch);
  }

  return false;
}

type ShellSyntaxOptions = {
  rejectShellSyntax?: boolean;
  onUnquotedGlob?: (argvIndex: number) => void;
};

/** Splits shell-like argv; strict callers can inspect globs instead of rejecting them. */
export function splitShellArgs(raw: string, options?: ShellSyntaxOptions): string[] | null {
  return splitQuotedArgs(raw, "shell", false, options);
}

/** Groups quoted process arguments, preserving literal backslashes and hash characters. */
export function splitCommandArgs(raw: string, options: { allowUnclosedQuotes: true }): string[];
export function splitCommandArgs(
  raw: string,
  options?: { allowUnclosedQuotes?: boolean },
): string[] | null;
export function splitCommandArgs(
  raw: string,
  options?: { allowUnclosedQuotes?: boolean },
): string[] | null {
  return splitQuotedArgs(raw, "command", options?.allowUnclosedQuotes);
}

function splitQuotedArgs(
  raw: string,
  syntax: "shell" | "command",
  allowUnclosedQuotes = false,
  options?: ShellSyntaxOptions,
): string[] | null {
  const rejectShellSyntax = options?.rejectShellSyntax;
  const backslashEscapes = syntax === "shell";
  const tokens: string[] = [];
  let buf = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let wordStarted = false;

  const pushToken = () => {
    if (buf.length > 0 || (rejectShellSyntax && wordStarted)) {
      tokens.push(buf);
      buf = "";
    }
    wordStarted = false;
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    // Continuations can hide an interpreter name from approval operand binding.
    if (rejectShellSyntax && quote !== "'" && ch === "\\" && /[\r\n]/u.test(raw[i + 1] ?? "")) {
      return null;
    }
    if (backslashEscapes && !quote && ch === "\\") {
      escaped = true;
      wordStarted = true;
      continue;
    }
    if (quote) {
      const next = raw[i + 1];
      // Inside double quotes, only POSIX-recognized escapes consume the backslash.
      if (quote === '"' && backslashEscapes && ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += next;
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
      } else {
        if (rejectShellSyntax && quote === '"' && (ch === "$" || ch === "`")) {
          return null;
        }
        buf += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      wordStarted = true;
      continue;
    }
    // In POSIX shells, "#" starts a comment only when it begins a word; keep
    // inline hashes inside tokens so URLs/fragments are not truncated.
    if (syntax === "shell" && ch === "#" && (rejectShellSyntax ? !wordStarted : buf.length === 0)) {
      if (rejectShellSyntax) {
        return null;
      }
      break;
    }
    if (rejectShellSyntax && /[*?[]/u.test(ch)) {
      if (!options?.onUnquotedGlob) {
        return null;
      }
      options.onUnquotedGlob(tokens.length);
    }
    if (rejectShellSyntax && /[;&|<>$`\r\n(){}~]/u.test(ch)) {
      return null;
    }
    if (/\s/.test(ch)) {
      // Only space and tab separate POSIX shell words; other whitespace must
      // not create a comment boundary in strict approval parsing.
      if (rejectShellSyntax && ch !== " " && ch !== "\t") {
        return null;
      }
      pushToken();
      continue;
    }
    buf += ch;
    wordStarted = true;
  }

  if (escaped || (!allowUnclosedQuotes && quote)) {
    return null;
  }
  pushToken();
  return tokens;
}
