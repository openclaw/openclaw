import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  consumeLineBreak,
  skipHorizontalWhitespace,
} from "../../../packages/tool-call-repair/src/grammar.js";
import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { trimTextPreservingCode, type TextFilter } from "./text-projection.js";

function consumeJsonish(input: string, start: number): number | null {
  let index = start;
  while (index < input.length && /[ \t\r\n]/.test(input[index] ?? "")) {
    index += 1;
  }
  const opening = input[index];
  if (opening === undefined) {
    return null;
  }
  if (opening !== "{" && opening !== "[" && opening !== '"') {
    while (index < input.length && input[index] !== "\n" && input[index] !== "\r") {
      index += 1;
    }
    return index;
  }

  // Downgraded history accepts quoted scalars and mixed container balance without JSON validation.
  let depth = opening === '"' ? 0 : 1;
  let inString = opening === '"';
  let escaped = false;
  for (index += 1; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
    if (!inString && depth === 0) {
      return index + 1;
    }
  }
  return null;
}

function stripDowngradedToolCalls(input: string): string {
  let codeRegions: ReturnType<typeof findCodeRegions> | undefined;
  let result = "";
  let cursor = 0;
  for (const match of input.matchAll(/\[Tool Call:[^\]]*\]/gi)) {
    const start = match.index;
    if (start < cursor || isInsideCode(start, (codeRegions ??= findCodeRegions(input)))) {
      continue;
    }
    result += input.slice(cursor, start);
    let index = skipHorizontalWhitespace(input, start + match[0].length);
    index = skipHorizontalWhitespace(input, consumeLineBreak(input, index) ?? index);
    if (normalizeLowercaseStringOrEmpty(input.slice(index, index + 9)) === "arguments") {
      index += 9;
      if (input[index] === ":") {
        index += 1;
      }
      if (input[index] === " ") {
        index += 1;
      }
      index = consumeJsonish(input, index) ?? index;
    }
    if (!result || result.endsWith("\n") || result.endsWith("\r")) {
      index = consumeLineBreak(input, index) ?? index;
    }
    cursor = index;
  }
  return result + input.slice(cursor);
}

/**
 * Strip downgraded tool call text representations that leak into user-visible
 * text content when replaying history across providers.
 */
export function stripDowngradedToolCallText(
  text: string,
  options?: { preserveTrailingWhitespace?: boolean },
): string {
  if (!text || (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text))) {
    return text;
  }
  let cleaned = stripDowngradedToolCalls(text);
  for (const pattern of [
    /\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi,
    /\[Historical context:[^\]]*\]\n?/gi,
  ]) {
    const input = cleaned;
    // An earlier removal can change Markdown ownership for the next marker family.
    let codeRegions: ReturnType<typeof findCodeRegions> | undefined;
    cleaned = input.replace(pattern, (match, offset: number) =>
      isInsideCode(offset, (codeRegions ??= findCodeRegions(input))) ? match : "",
    );
  }
  return trimTextPreservingCode(cleaned, options?.preserveTrailingWhitespace ? "start" : "both");
}

export function downgradedToolCallTextFilter(options?: {
  preserveTrailingWhitespace?: boolean;
}): TextFilter {
  return {
    transform: (text) => stripDowngradedToolCallText(text, options),
    activationTokens: ["[Tool Call", "[Tool Result", "[Historical context"],
  };
}
