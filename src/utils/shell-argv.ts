/**
 * POSIX-shell argument tokeniser.
 *
 * Splits a shell command string into an argv array following the POSIX
 * quoting rules that matter for openclaw's /run and cron command fields:
 *
 *  - Backslash outside quotes escapes the next character.
 *  - Single quotes preserve everything literally (no escapes inside).
 *  - Double quotes allow backslash-escaping of \\ " $ ` \n \r only.
 *  - An unquoted '#' at the start of a token begins a comment (discarded).
 *
 * Returns null on unterminated quotes or trailing backslash so callers can
 * surface a user-friendly error instead of silently dropping characters.
 *
 * Security note (CWE-78: OS Command Injection):
 *   This tokeniser does NOT expand variables, globs, or command substitution.
 *   It is used only to split a pre-validated command string into argv tokens
 *   for execFile() / spawn() with the shell option disabled.  Never pass the
 *   resulting tokens to a shell interpreter.
 *
 * Performance note:
 *   The whitespace check in the hot inner loop uses charCode arithmetic
 *   instead of /\s/.test(ch) to avoid constructing a regex match object
 *   on every character.  The POSIX whitespace set for command splitting is
 *   space (32), tab (9), newline (10), carriage return (13), form feed (12),
 *   and vertical tab (11) — all below ASCII 33.
 */

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

  const pushToken = () => {
    if (buf.length > 0) {
      tokens.push(buf);
      buf = "";
    }
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      buf += ch;
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
      }
      continue;
    }
    if (inDouble) {
      const next = raw[i + 1];
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += next;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    // In POSIX shells, "#" starts a comment only when it begins a word.
    if (ch === "#" && buf.length === 0) {
      break;
    }
    // charCode < 33 covers space(32) tab(9) LF(10) CR(13) FF(12) VT(11).
    if (ch.charCodeAt(0) < 33) {
      pushToken();
      continue;
    }
    buf += ch;
  }

  if (escaped || inSingle || inDouble) {
    return null;
  }
  pushToken();
  return tokens;
}
