// Decodes and classifies Bash words for the command explainer.
import type { Node as TreeSitterNode } from "web-tree-sitter";

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

type ShellWordValue = { kind: "literal"; value: string } | { kind: "dynamic"; value: string };

const DYNAMIC_WORD_NODE_TYPES = new Set([
  "arithmetic_expansion",
  "command_substitution",
  "expansion",
  "process_substitution",
  "simple_expansion",
]);

function hasDynamicWordPart(root: TreeSitterNode): boolean {
  const pending = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (DYNAMIC_WORD_NODE_TYPES.has(node.type)) {
      return true;
    }
    for (const child of node.namedChildren) {
      pending.push(child);
    }
  }
  return false;
}

export function shellWordValue(node: TreeSitterNode): ShellWordValue {
  if (DYNAMIC_WORD_NODE_TYPES.has(node.type)) {
    return { kind: "dynamic", value: node.text };
  }
  if (
    node.type !== "command_name" &&
    node.type !== "concatenation" &&
    node.namedChildren.some((child) => hasDynamicWordPart(child))
  ) {
    return {
      kind: "dynamic",
      value: node.type === "string" ? decodeShellText(node.text, "double") : node.text,
    };
  }

  switch (node.type) {
    case "command_name":
    case "concatenation": {
      const parts = node.namedChildren;
      if (
        node.type === "command_name" ? parts.length === 0 : hasUnescapedDynamicPattern(node.text)
      ) {
        return {
          kind: hasUnescapedDynamicPattern(node.text) ? "dynamic" : "literal",
          value: decodeShellText(node.text),
        };
      }
      let value = "";
      let dynamic = false;
      for (const part of parts) {
        const partValue = shellWordValue(part);
        value += partValue.value;
        if (partValue.kind !== "literal") {
          dynamic = true;
          if (node.type === "command_name") {
            break;
          }
        }
      }
      return { kind: dynamic ? "dynamic" : "literal", value };
    }
    case "word":
      return {
        kind: hasUnescapedDynamicPattern(node.text) ? "dynamic" : "literal",
        value: decodeShellText(node.text),
      };
    case "raw_string":
      return { kind: "literal", value: node.text.slice(1, -1) };
    case "string":
      return { kind: "literal", value: decodeShellText(node.text, "double") };
    case "ansi_c_string":
      return { kind: "literal", value: decodeShellText(node.text, "ansi-c") };
    default:
      return {
        kind: node.namedChildren.some((child) => shellWordValue(child).kind === "dynamic")
          ? "dynamic"
          : "literal",
        value: decodeShellText(node.text),
      };
  }
}
