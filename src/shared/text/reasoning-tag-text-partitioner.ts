import {
  buildCodeSpanIndex,
  createInlineCodeState,
  type InlineCodeState,
} from "../../../packages/markdown-core/src/code-spans.js";
import type { FenceScanState } from "../../../packages/markdown-core/src/fences.js";

export type ReasoningTagTextDelta =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string };

const REASONING_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:)?(?:think(?:ing)?|thought|reasoning)|antthinking)\b[^<>]*>/gi;
const REASONING_TAG_NAMES = [
  "think",
  "thinking",
  "thought",
  "reasoning",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
  "antml:reasoning",
] as const;

/** Stateful stream splitter that keeps model reasoning tags out of visible text. */
export interface ReasoningTagTextPartitioner {
  markStrict(): void;
  push(chunk: string): ReasoningTagTextDelta[];
  pushVisible(chunk: string): ReasoningTagTextDelta[];
  flush(): ReasoningTagTextDelta[];
  hasPending(): boolean;
  isInsideReasoning(): boolean;
}

/** Creates a streaming partitioner for visible text and hidden reasoning deltas. */
export function createReasoningTagTextPartitioner(): ReasoningTagTextPartitioner {
  let buffer = "";
  let reasoningDepth = 0;
  let strictMode = false;
  let emittedVisibleText = false;
  let inlineCodeState: InlineCodeState = createInlineCodeState();
  let fenceState: FenceScanState | undefined;
  let hiddenInlineCodeState: InlineCodeState = createInlineCodeState();
  let hiddenFenceState: FenceScanState | undefined;
  let recoverableOpenTagText: string | undefined;

  /** Consumes buffered text while preserving partial tags/code spans for later chunks. */
  const consume = (final: boolean, recoverFullUnclosed: boolean): ReasoningTagTextDelta[] => {
    const output: ReasoningTagTextDelta[] = [];
    const emit = (kind: ReasoningTagTextDelta["kind"], text: string) => {
      if (!text) {
        return;
      }
      if (kind === "text" && text.trim().length > 0) {
        emittedVisibleText = true;
      }
      if (kind === "text") {
        const nextCode = buildCodeSpanIndex(text, inlineCodeState, fenceState);
        inlineCodeState = nextCode.inlineState;
        fenceState = nextCode.fenceState;
      } else {
        const nextCode = buildCodeSpanIndex(text, hiddenInlineCodeState, hiddenFenceState);
        hiddenInlineCodeState = nextCode.inlineState;
        hiddenFenceState = nextCode.fenceState;
      }
      const previous = output[output.length - 1];
      if (previous?.kind === kind) {
        previous.text += text;
        return;
      }
      output.push({ kind, text });
    };

    while (buffer) {
      const activeInlineCodeState = reasoningDepth === 0 ? inlineCodeState : hiddenInlineCodeState;
      const activeFenceState = reasoningDepth === 0 ? fenceState : hiddenFenceState;
      const codeSpans = buildCodeSpanIndex(buffer, activeInlineCodeState, activeFenceState);
      const hasUnclosedCode =
        reasoningDepth === 0 && Boolean(codeSpans.inlineState.open || codeSpans.fenceState.open);
      const hasRawReasoning = hasRawReasoningTag(buffer);
      const tag = findNextReasoningTag(buffer, (index) =>
        final && hasUnclosedCode && hasRawReasoning ? false : codeSpans.isInside(index),
      );
      if (!tag) {
        if (final) {
          const recoverAsText =
            reasoningDepth > 0 && recoverFullUnclosed && !hasRawReasoningCloseTag(buffer);
          const recoveredText =
            recoverAsText && recoverableOpenTagText ? recoverableOpenTagText + buffer : buffer;
          emit(reasoningDepth > 0 && !recoverAsText ? "thinking" : "text", recoveredText);
          buffer = "";
          reasoningDepth = 0;
          recoverableOpenTagText = undefined;
          return output;
        }
        if (
          reasoningDepth > 0 &&
          recoverFullUnclosed &&
          (!emittedVisibleText || recoverableOpenTagText)
        ) {
          // Visible-mode streams may be fully wrapped in an unclosed reasoning tag;
          // hold the buffer until flush can decide whether to recover it as text.
          return output;
        }
        if (hasUnclosedCode && hasRawReasoning) {
          const openCodeIndex =
            inlineCodeState.open || fenceState?.open ? 0 : findOpenCodeContextStart(buffer);
          if (openCodeIndex !== -1) {
            emit("text", buffer.slice(0, openCodeIndex));
            buffer = buffer.slice(openCodeIndex);
            return output;
          }
        }
        const trailingFenceStart = findTrailingFenceFragmentStart(
          buffer,
          activeInlineCodeState,
          activeFenceState,
        );
        if (trailingFenceStart !== -1) {
          emit(reasoningDepth > 0 ? "thinking" : "text", buffer.slice(0, trailingFenceStart));
          buffer = buffer.slice(trailingFenceStart);
          return output;
        }
        const keepFrom = reasoningTagPrefixSuffixIndex(buffer, (index) =>
          codeSpans.isInside(index),
        );
        if (keepFrom === -1) {
          emit(reasoningDepth > 0 ? "thinking" : "text", buffer);
          buffer = "";
          return output;
        }
        if (
          reasoningDepth === 0 &&
          keepFrom > 0 &&
          buffer.slice(0, keepFrom).trim().length > 0 &&
          isReasoningCloseTagPrefix(buffer.slice(keepFrom))
        ) {
          // In strict mode, wait for a split orphan close tag plus visible suffix
          // so the hidden prefix can be dropped without leaking it first.
          return output;
        }
        if (keepFrom > 0) {
          emit(reasoningDepth > 0 ? "thinking" : "text", buffer.slice(0, keepFrom));
          buffer = buffer.slice(keepFrom);
        }
        return output;
      }

      const beforeTag = buffer.slice(0, tag.index);
      const afterTag = buffer.slice(tag.index + tag.text.length);
      if (tag.isClose && reasoningDepth === 0) {
        if (recoverFullUnclosed && beforeTag.trim().length > 0 && afterTag.trim().length > 0) {
          emit("text", beforeTag + tag.text);
          buffer = afterTag;
          continue;
        }
        if (beforeTag.trim().length > 0 && afterTag.trim().length === 0 && !final) {
          return output;
        }
        if (beforeTag.trim().length === 0 || afterTag.trim().length === 0) {
          emit("text", beforeTag);
        }
        buffer = afterTag;
        continue;
      }

      emit(reasoningDepth > 0 ? "thinking" : "text", buffer.slice(0, tag.index));
      buffer = afterTag;
      if (tag.isClose) {
        reasoningDepth = Math.max(0, reasoningDepth - 1);
        if (reasoningDepth === 0) {
          recoverableOpenTagText = undefined;
          hiddenInlineCodeState = createInlineCodeState();
          hiddenFenceState = undefined;
        }
      } else {
        if (reasoningDepth === 0) {
          // Only recover a later-unclosed open tag as visible prose after real
          // visible text has already appeared; fully wrapped output stays hidden.
          recoverableOpenTagText = recoverFullUnclosed && emittedVisibleText ? tag.text : undefined;
          hiddenInlineCodeState = createInlineCodeState();
          hiddenFenceState = undefined;
        }
        reasoningDepth += 1;
      }
    }
    return output;
  };

  return {
    markStrict() {
      strictMode = true;
    },
    push(chunk: string) {
      strictMode = true;
      buffer += chunk;
      return consume(false, false);
    },
    pushVisible(chunk: string) {
      buffer += chunk;
      return consume(false, true);
    },
    flush() {
      return consume(true, !strictMode);
    },
    hasPending() {
      return buffer.length > 0 || reasoningDepth > 0;
    },
    isInsideReasoning() {
      return reasoningDepth > 0;
    },
  };
}

/** Finds any complete reasoning tag in raw text, including split-stream aliases. */
function hasRawReasoningTag(text: string): boolean {
  REASONING_TAG_RE.lastIndex = 0;
  return REASONING_TAG_RE.test(text);
}

/** Checks whether a buffer contains a complete closing reasoning tag. */
function hasRawReasoningCloseTag(text: string): boolean {
  REASONING_TAG_RE.lastIndex = 0;
  for (;;) {
    const match = REASONING_TAG_RE.exec(text);
    if (!match) {
      return false;
    }
    if (match[1] === "/") {
      return true;
    }
  }
}

/** Finds the next complete reasoning tag outside code spans/fences. */
function findNextReasoningTag(
  text: string,
  isIndexInsideCode: (index: number) => boolean,
): { index: number; text: string; isClose: boolean } | null {
  REASONING_TAG_RE.lastIndex = 0;
  for (;;) {
    const match = REASONING_TAG_RE.exec(text);
    if (!match) {
      return null;
    }
    if (!isIndexInsideCode(match.index)) {
      return {
        index: match.index,
        text: match[0],
        isClose: match[1] === "/",
      };
    }
  }
}

/** Returns the start of a trailing partial reasoning tag that must stay buffered. */
function reasoningTagPrefixSuffixIndex(
  text: string,
  isIndexInsideCode: (index: number) => boolean,
): number {
  for (let index = text.lastIndexOf("<"); index >= 0; ) {
    if (!isIndexInsideCode(index) && isReasoningTagPrefix(text.slice(index))) {
      return index;
    }
    if (index === 0) {
      break;
    }
    index = text.lastIndexOf("<", index - 1);
  }
  return -1;
}

/** Accepts partial opening or closing tag names while chunks are still arriving. */
function isReasoningTagPrefix(text: string): boolean {
  const name = normalizeReasoningTagPrefixName(text);
  return REASONING_TAG_NAMES.some((tagName) => {
    if (tagName.startsWith(name)) {
      return true;
    }
    if (!name.startsWith(tagName)) {
      return false;
    }
    const rest = name.slice(tagName.length);
    return rest.length === 0 || /^[\s/>]/.test(rest);
  });
}

/** Detects a partial closing tag so strict mode can hold hidden text. */
function isReasoningCloseTagPrefix(text: string): boolean {
  const normalized = text
    .replace(/^<\s*/, "<")
    .replace(/^<\s*\//, "</")
    .replace(/^<\/\s*/, "</")
    .toLowerCase();
  return normalized.startsWith("</") && isReasoningTagPrefix(text);
}

/** Normalizes a partial tag prefix enough to compare against known tag aliases. */
function normalizeReasoningTagPrefixName(text: string): string {
  const normalized = text
    .replace(/^<\s*/, "<")
    .replace(/^<\s*\//, "</")
    .replace(/^<\/\s*/, "</")
    .toLowerCase();
  const rawName = normalized.startsWith("</") ? normalized.slice(2) : normalized.slice(1);
  return rawName.trimStart();
}

/** Finds the earliest unclosed inline-code or fence context in the buffered suffix. */
function findOpenCodeContextStart(text: string): number {
  const fence = findOpenFenceStart(text);
  const inline = findOpenInlineCodeStart(text);
  if (fence === -1) {
    return inline;
  }
  if (inline === -1) {
    return fence;
  }
  return Math.min(fence, inline);
}

/** Finds an unmatched backtick run in a buffered inline-code suffix. */
function findOpenInlineCodeStart(text: string): number {
  let openStart = -1;
  let openTicks = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    const runStart = index;
    let runLength = 0;
    while (index < text.length && text[index] === "`") {
      runLength += 1;
      index += 1;
    }
    if (openStart === -1) {
      openStart = runStart;
      openTicks = runLength;
    } else if (runLength === openTicks) {
      openStart = -1;
      openTicks = 0;
    }
  }
  return openStart;
}

/** Finds an unmatched fenced-code opener in a buffered markdown suffix. */
function findOpenFenceStart(text: string): number {
  const fenceRe = /(^|\n)(```|~~~)[^\n]*(?:\n|$)/g;
  let open: { marker: string; index: number } | null = null;
  for (const match of text.matchAll(fenceRe)) {
    const index = (match.index ?? 0) + match[1].length;
    const marker = match[2] ?? "";
    if (open !== null && open.marker === marker) {
      open = null;
    } else if (!open) {
      open = { marker, index };
    }
  }
  return open?.index ?? -1;
}

/** Holds a split fence marker so reasoning-looking examples remain visible. */
function findTrailingFenceFragmentStart(
  text: string,
  inlineState: InlineCodeState,
  fenceState: FenceScanState | undefined,
): number {
  if (inlineState.open || fenceState?.open) {
    return -1;
  }
  const lineStart = Math.max(text.lastIndexOf("\n") + 1, 0);
  const line = text.slice(lineStart);
  const match = line.match(/^( {0,3})(`{1,2}|~{1,2})$/);
  return match ? lineStart : -1;
}
