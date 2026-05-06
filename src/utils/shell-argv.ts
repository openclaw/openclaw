const DOUBLE_QUOTE_ESCAPES = new Set(["\\", '"', "$", "`", "\n", "\r"]);

function isDoubleQuoteEscape(next: string | undefined): next is string {
  return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}

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
    const ch = raw[i];
    if (escaped) {
      buf += ch;
      tokenStarted = true;
      escaped = false;
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
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += next;
        tokenStarted = true;
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
      tokenStarted = true;
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      tokenStarted = true;
      inDouble = true;
      continue;
    }
    // In POSIX shells, "#" starts a comment only when it begins a word.
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
