// Decodes and classifies raw bash word text for the command explainer.
export function hasEscapedLineContinuation(text: string): boolean {
  return /\\(?:\r\n|[\r\n])/.test(text);
}

export function hasUnescapedDynamicPattern(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === "*" || ch === "?") {
      return true;
    }
    if (ch === "[" && text.indexOf("]", index + 1) > index + 1) {
      return true;
    }
    if (ch === "{" && text.indexOf("}", index + 1) > index + 1) {
      return true;
    }
  }
  return false;
}

const ANSI_C_SIMPLE_ESCAPES: Record<string, string> = {
  "'": "'",
  '"': '"',
  "?": "?",
  "\\": "\\",
  a: "\u0007",
  b: "\b",
  e: "\u001B",
  E: "\u001B",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

export function decodeShellText(
  text: string,
  quoting: "unquoted" | "double" | "ansi-c" = "unquoted",
  sourceOffsets?: number[],
): string {
  const prefix = quoting === "double" ? '"' : quoting === "ansi-c" ? "$'" : "";
  const hasQuotes = prefix && text.startsWith(prefix) && text.endsWith(prefix.slice(-1));
  const bodyStart = hasQuotes ? prefix.length : 0;
  const body = hasQuotes ? text.slice(bodyStart, -1) : text;
  let decoded = "";
  if (sourceOffsets) {
    sourceOffsets.push(bodyStart);
  }
  const append = (value: string, sourceEndOffset: number) => {
    decoded += value;
    if (sourceOffsets) {
      // Source offsets count UTF-16 units, including both halves of an ANSI-C code point.
      for (let remaining = value.length; remaining > 0; remaining -= 1) {
        sourceOffsets.push(sourceEndOffset);
      }
    }
  };
  for (let index = 0; index < body.length; index += 1) {
    const ch = body.charAt(index);
    const next = body[index + 1];
    const sourceOffset = bodyStart + index;
    if (
      ch !== "\\" ||
      next === undefined ||
      (quoting === "double" && !["\\", '"', "$", "`", "\n", "\r"].includes(next))
    ) {
      append(ch, sourceOffset + 1);
      continue;
    }
    if (quoting !== "ansi-c" && (next === "\n" || next === "\r")) {
      const width = next === "\r" && body[index + 2] === "\n" ? 3 : 2;
      if (sourceOffsets) {
        sourceOffsets[decoded.length] = sourceOffset + width;
      }
      index += width - 1;
      continue;
    }

    let digits: string | undefined;
    let radix = 16;
    let prefixLength = 2;
    if (quoting === "ansi-c") {
      if (next === "x" || next === "u" || next === "U") {
        const maxLength = next === "x" ? 2 : next === "u" ? 4 : 8;
        digits = body.slice(index + 2).match(new RegExp(`^[0-9A-Fa-f]{1,${maxLength}}`))?.[0];
      } else if (/^[0-7]$/.test(next)) {
        digits = body.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
        radix = 8;
        prefixLength = 1;
      }
    }
    if (digits) {
      const endOffset = sourceOffset + prefixLength + digits.length;
      try {
        append(String.fromCodePoint(Number.parseInt(digits, radix)), endOffset);
      } catch {
        append(`\\${next}${digits}`, endOffset);
      }
      index += prefixLength + digits.length - 1;
      continue;
    }

    const value = quoting === "ansi-c" ? (ANSI_C_SIMPLE_ESCAPES[next] ?? next) : next;
    append(value, sourceOffset + 2);
    index += 1;
  }
  return decoded;
}
