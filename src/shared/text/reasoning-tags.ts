import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { findFinalTagMatches } from "./final-tags.js";
export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";

const QUICK_TAG_RE = /<\s*\/?\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking|final)\b/i;
const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;

const REASONING_TAG_ANCHORED_RE =
  /^<\s*(\/?)\s*(?:(?:antml:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/i;
const REASONING_TAG_KEYWORDS = [
  "antml:thinking",
  "antml:thought",
  "antml:think",
  "antthinking",
  "thinking",
  "thought",
  "think",
] as const;

function applyTrim(value: string, mode: ReasoningTagTrim): string {
  if (mode === "none") {
    return value;
  }
  if (mode === "start") {
    return value.trimStart();
  }
  return value.trim();
}

export function hasOrphanReasoningCloseBoundary(params: {
  before: string;
  after: string;
}): boolean {
  return params.before.trim().length > 0 && params.after.trim().length > 0;
}

export function stripReasoningTagsFromText(
  text: string,
  options?: {
    mode?: ReasoningTagMode;
    trim?: ReasoningTagTrim;
  },
): string {
  if (!text) {
    return text;
  }
  if (!QUICK_TAG_RE.test(text)) {
    return text;
  }

  const mode = options?.mode ?? "strict";
  const trimMode = options?.trim ?? "both";

  let cleaned = text;
  const matches = findFinalTagMatches(cleaned);
  THINKING_TAG_RE.lastIndex = 0;
  const hasThinkingTag = THINKING_TAG_RE.test(cleaned);
  THINKING_TAG_RE.lastIndex = 0;
  if (matches.length === 0 && !hasThinkingTag) {
    return text;
  }
  if (matches.length > 0) {
    const finalMatches: Array<{ start: number; length: number; inCode: boolean }> = [];
    const preCodeRegions = findCodeRegions(cleaned);
    for (const match of matches) {
      const start = match.index;
      finalMatches.push({
        start,
        length: match.text.length,
        inCode: isInsideCode(start, preCodeRegions),
      });
    }

    for (let i = finalMatches.length - 1; i >= 0; i--) {
      const m = finalMatches[i];
      if (!m.inCode) {
        cleaned = cleaned.slice(0, m.start) + cleaned.slice(m.start + m.length);
      }
    }
  }

  const codeRegions = findCodeRegions(cleaned);

  THINKING_TAG_RE.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let thinkingDepth = 0;
  let firstUnclosedContentIndex: number | undefined;

  for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";

    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    if (thinkingDepth === 0) {
      if (isClose) {
        const afterIndex = idx + match[0].length;
        const before = cleaned.slice(lastIndex, idx);
        const after = cleaned.slice(afterIndex);
        if (hasOrphanReasoningCloseBoundary({ before, after })) {
          result = "";
        } else {
          result += before;
        }
        lastIndex = afterIndex;
        continue;
      }
      result += cleaned.slice(lastIndex, idx);
      thinkingDepth = 1;
      firstUnclosedContentIndex = idx + match[0].length;
    } else if (isClose) {
      thinkingDepth -= 1;
      if (thinkingDepth === 0) {
        firstUnclosedContentIndex = undefined;
      }
    } else {
      thinkingDepth += 1;
    }

    lastIndex = idx + match[0].length;
  }

  if (thinkingDepth === 0 || mode === "preserve") {
    result += cleaned.slice(lastIndex);
  }

  const trimmedResult = applyTrim(result, trimMode);
  if (
    mode === "strict" &&
    thinkingDepth > 0 &&
    !trimmedResult &&
    firstUnclosedContentIndex !== undefined &&
    cleaned.trim()
  ) {
    return applyTrim(cleaned.slice(firstUnclosedContentIndex), trimMode);
  }

  return trimmedResult;
}

export interface ReasoningTagTextFilter {
  push(chunk: string): string[];
  flush(): string[];
}

function reasoningTagPartialAtTail(buffer: string): boolean {
  const head = /^<\s*\/?\s*/.exec(buffer);
  if (!head) {
    return false;
  }
  const rest = buffer.slice(head[0].length);
  if (rest.length === 0) {
    return true;
  }
  if (/[<>]/.test(rest)) {
    return false;
  }
  const restLower = rest.toLowerCase();
  for (const keyword of REASONING_TAG_KEYWORDS) {
    if (keyword.startsWith(restLower)) {
      return true;
    }
    if (restLower.startsWith(keyword)) {
      const after = rest.slice(keyword.length);
      if (after.length === 0 || /^[^A-Za-z0-9_]/.test(after)) {
        return true;
      }
    }
  }
  return false;
}

function runLengthAt(buffer: string, index: number, marker: string): number {
  let length = 0;
  while (buffer[index + length] === marker) {
    length += 1;
  }
  return length;
}

function trailingPrefixLength(buffer: string, token: string): number {
  const maxLength = Math.min(buffer.length, token.length - 1);
  for (let length = maxLength; length > 0; length--) {
    if (token.startsWith(buffer.slice(buffer.length - length))) {
      return length;
    }
  }
  return 0;
}

export function createReasoningTagTextFilter(): ReasoningTagTextFilter {
  let buffer = "";
  let thinkingDepth = 0;
  let droppedThinking = "";
  let fenceMarker = "";
  let atLineStart = true;
  let keptVisible = false;

  const consume = (final: boolean): string[] => {
    const output: string[] = [];
    const keep = (text: string) => {
      if (text) {
        output.push(text);
      }
    };
    const drop = (text: string) => {
      droppedThinking += text;
    };
    const keepVisible = (text: string) => {
      if (text) {
        keep(text);
        atLineStart = text.endsWith("\n");
        if (text.trim()) {
          keptVisible = true;
        }
      }
    };

    while (buffer.length > 0) {
      if (fenceMarker) {
        const closeToken = `\n${fenceMarker}`;
        const close = buffer.indexOf(closeToken);
        if (close >= 0) {
          const end = close + closeToken.length;
          keep(buffer.slice(0, end));
          buffer = buffer.slice(end);
          fenceMarker = "";
          atLineStart = false;
          continue;
        }
        if (final) {
          keep(buffer);
          buffer = "";
          fenceMarker = "";
          break;
        }
        const hold = trailingPrefixLength(buffer, closeToken);
        keep(buffer.slice(0, buffer.length - hold));
        buffer = buffer.slice(buffer.length - hold);
        return output;
      }

      if (thinkingDepth > 0) {
        const open = buffer.indexOf("<");
        if (open === -1) {
          drop(buffer);
          buffer = "";
          break;
        }
        if (open > 0) {
          drop(buffer.slice(0, open));
          buffer = buffer.slice(open);
          continue;
        }
        const tag = REASONING_TAG_ANCHORED_RE.exec(buffer);
        if (tag) {
          if (tag[1] === "/") {
            thinkingDepth -= 1;
            if (thinkingDepth === 0) {
              droppedThinking = "";
            }
          } else {
            thinkingDepth += 1;
          }
          buffer = buffer.slice(tag[0].length);
          continue;
        }
        if (!final && reasoningTagPartialAtTail(buffer)) {
          return output;
        }
        drop(buffer.slice(0, 1));
        buffer = buffer.slice(1);
        continue;
      }

      const special = buffer.search(/[<`~]/);
      if (special === -1) {
        keepVisible(buffer);
        buffer = "";
        break;
      }
      if (special > 0) {
        keepVisible(buffer.slice(0, special));
        buffer = buffer.slice(special);
        continue;
      }

      const ch = buffer[0];
      if (ch === "`" || ch === "~") {
        const run = runLengthAt(buffer, 0, ch);
        if (!final && run === buffer.length) {
          return output;
        }
        if (atLineStart && run >= 3) {
          keepVisible(buffer.slice(0, run));
          buffer = buffer.slice(run);
          fenceMarker = ch.repeat(3);
          atLineStart = false;
          continue;
        }
        if (ch === "~") {
          keepVisible(buffer.slice(0, run));
          buffer = buffer.slice(run);
          atLineStart = false;
          continue;
        }
        const close = buffer.indexOf("`", run);
        if (close === -1) {
          if (!final) {
            return output;
          }
          keepVisible(buffer.slice(0, run));
          buffer = buffer.slice(run);
          atLineStart = false;
          continue;
        }
        const closeEnd = close + runLengthAt(buffer, close, "`");
        keepVisible(buffer.slice(0, closeEnd));
        buffer = buffer.slice(closeEnd);
        atLineStart = false;
        continue;
      }

      const tag = REASONING_TAG_ANCHORED_RE.exec(buffer);
      if (tag) {
        if (tag[1] === "/") {
          keepVisible(buffer.slice(0, tag[0].length));
        } else {
          thinkingDepth += 1;
        }
        buffer = buffer.slice(tag[0].length);
        atLineStart = false;
        continue;
      }
      if (!final && reasoningTagPartialAtTail(buffer)) {
        return output;
      }
      keepVisible(buffer.slice(0, 1));
      buffer = buffer.slice(1);
    }

    if (final && thinkingDepth > 0 && droppedThinking && !keptVisible) {
      keep(droppedThinking);
      droppedThinking = "";
      thinkingDepth = 0;
    }
    return output;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      return consume(false);
    },
    flush() {
      return consume(true);
    },
  };
}
