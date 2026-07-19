// Shell argv helpers quote and parse shell-style argument strings.
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
      if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && raw[i + 1] === "\n") {
          i += 1;
        }
        escaped = false;
        continue;
      }
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

/** Splits a shell-like argv string into tokens, returning null for unterminated quotes or escapes. */
export function splitShellArgs(raw: string): string[] | null {
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let tokenStarted = false;

  const pushToken = () => {
    if (tokenStarted) {
      tokens.push(buf);
      buf = "";
      tokenStarted = false;
    }
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    if (escaped) {
      if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && raw[i + 1] === "\n") {
          i += 1;
        }
        escaped = false;
        continue;
      }
      buf += ch;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        buf += ch;
        tokenStarted = true;
      }
      continue;
    }
    if (inDouble) {
      const next = raw[i + 1];
      // Inside double quotes, only POSIX-recognized escapes consume the backslash.
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        if (next !== "\n" && next !== "\r") {
          buf += next;
          tokenStarted = true;
        } else if (next === "\r" && raw[i + 2] === "\n") {
          i += 1;
        }
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      } else {
        buf += ch;
        tokenStarted = true;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      tokenStarted = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      tokenStarted = true;
      continue;
    }
    // In POSIX shells, "#" starts a comment only when it begins a word; keep
    // inline hashes inside tokens so URLs/fragments are not truncated.
    if (ch === "#" && !tokenStarted) {
      break;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
    tokenStarted = true;
  }

  if (escaped || inSingle || inDouble) {
    return null;
  }
  pushToken();
  return tokens;
}
