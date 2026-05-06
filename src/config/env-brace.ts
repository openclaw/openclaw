/**
 * Finds the index of the closing '}' that matches the '{' at position `openPos`
 * in `str`, accounting for nested braces and skipping quoted strings.
 * Returns -1 if no match is found.
 *
 * Quoted strings (double or single) are treated as opaque — braces inside them
 * do not affect depth. This prevents e.g. `${VAR:-{"key":"}"}}` from
 * mis-identifying the `}` inside `"}"` as the structural closing brace.
 */
export function findClosingBrace(str: string, openPos: number): number {
  let depth = 1;
  for (let i = openPos + 1; i < str.length; i++) {
    const ch = str[i];
    // Skip quoted strings — braces inside them are not structural.
    // If no matching closing quote is found before end-of-string, treat the
    // initial quote as a literal character (handles e.g. `don't` in defaults).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const savedPos = i;
      i++;
      while (i < str.length && str[i] !== quote) {
        if (str[i] === "\\") {
          i++;
        } // skip escaped char
        i++;
      }
      if (i < str.length) {
        // Found matching closing quote; i points at it, loop increment advances past it
        continue;
      }
      // No matching quote — treat the initial quote as a literal character
      i = savedPos;
      // Fall through: quote is neither '{' nor '}', so brace depth is unaffected
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      if (--depth === 0) {
        return i;
      }
    }
  }
  return -1;
}
