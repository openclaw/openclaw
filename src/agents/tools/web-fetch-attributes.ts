import {
  isAsciiWhitespace,
  isTagNameChar,
} from "../../../packages/markdown-core/src/html-scanner.js";

const RENDER_UNQUOTED_VALUE_BREAK = /["'=<>`]/;

/** Keep rendering's href grammar distinct from complete visibility attribute names. */
export function readHtmlAttribute(
  input: string,
  attribute: string,
  mode: "render" | "visibility" = "visibility",
): string | undefined {
  const rendering = mode === "render";
  let pos = 0;
  if (rendering) {
    while (pos < input.length && !isAsciiWhitespace(input.charAt(pos))) {
      pos += 1;
    }
  }
  while (pos < input.length) {
    while (
      pos < input.length &&
      (isAsciiWhitespace(input.charAt(pos)) || input.charAt(pos) === "/")
    ) {
      pos += 1;
    }
    const nameStart = pos;
    // Visibility consumes a leading equals sign as part of a malformed name.
    if (!rendering && input.charAt(pos) === "=") {
      pos += 1;
    }
    while (
      pos < input.length &&
      (rendering
        ? isTagNameChar(input.charAt(pos))
        : !isAsciiWhitespace(input.charAt(pos)) &&
          input.charAt(pos) !== "/" &&
          input.charAt(pos) !== "=")
    ) {
      pos += 1;
    }
    if (pos === nameStart) {
      if (!rendering) {
        break;
      }
      pos = skipUnsupportedAttribute(input, pos);
      continue;
    }
    const name = input.slice(nameStart, pos).toLowerCase();
    while (pos < input.length && isAsciiWhitespace(input.charAt(pos))) {
      pos += 1;
    }
    let value = "";
    if (input.charAt(pos) === "=") {
      pos += 1;
      while (pos < input.length && isAsciiWhitespace(input.charAt(pos))) {
        pos += 1;
      }
      const quote = input.charAt(pos);
      if (quote === '"' || quote === "'") {
        const valueStart = pos + 1;
        const valueEnd = input.indexOf(quote, valueStart);
        value = input.slice(valueStart, valueEnd === -1 ? undefined : valueEnd);
        pos = valueEnd === -1 ? input.length : valueEnd + 1;
      } else {
        const valueStart = pos;
        while (pos < input.length && !isAsciiWhitespace(input.charAt(pos))) {
          if (rendering && RENDER_UNQUOTED_VALUE_BREAK.test(input.charAt(pos))) {
            break;
          }
          pos += 1;
        }
        value = input.slice(valueStart, pos);
      }
    }
    if (name === attribute) {
      return value;
    }
  }
  return undefined;
}

function skipUnsupportedAttribute(input: string, start: number): number {
  let pos = start;
  while (pos < input.length && !isAsciiWhitespace(input.charAt(pos))) {
    const quote = input.charAt(pos);
    if (quote === '"' || quote === "'") {
      const valueEnd = input.indexOf(quote, pos + 1);
      pos = valueEnd === -1 ? input.length : valueEnd + 1;
      continue;
    }
    pos += 1;
  }
  return pos;
}
