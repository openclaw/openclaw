import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  buildCodeSpanIndex,
  createInlineCodeState,
} from "../../packages/markdown-core/src/code-spans.js";
import type { FenceScanState } from "../../packages/markdown-core/src/fences.js";
import type { AssistantDeliveryTtsFacts } from "../llm/types.js";
import { replaceOutsideCodeRegionParts } from "../utils/directive-tags.js";

/** Colon bodies without directive tokens are visible speech, except reserved text markers. */
function resolveTtsDirectiveBody(body: string): string | undefined {
  const text = body.trim();
  return text && !text.includes("=") && text.toLowerCase() !== "text" ? text : undefined;
}

/** Extract final-text TTS syntax into persisted facts, leaving markdown code spans unchanged. */
export function extractTtsDirectiveFacts(text: string): {
  cleanedText: string;
  facts?: AssistantDeliveryTtsFacts;
} {
  return expectDefined(extractTtsDirectiveParts([text])[0], "single TTS directive part");
}

export function extractTtsDirectiveParts(texts: readonly string[]): Array<{
  cleanedText: string;
  facts?: AssistantDeliveryTtsFacts;
}> {
  const parts: Array<{ cleanedText: string; facts?: AssistantDeliveryTtsFacts }> = texts.map(
    (cleanedText) => ({ cleanedText }),
  );
  if (!/\[\[\s*\/?\s*tts(?:\s*:|\s*\]\])/iu.test(texts.join("\n"))) {
    return parts;
  }
  const replaceStage = (
    regex: RegExp,
    replacement: (captures: unknown[], facts: AssistantDeliveryTtsFacts) => string,
  ) => {
    const cleanedTexts = replaceOutsideCodeRegionParts(
      parts.map((part) => part.cleanedText),
      regex,
      (_match, captures, _offset, _source, partIndex) => {
        const part = expectDefined(parts[partIndex], "TTS directive start part");
        return replacement(captures, (part.facts ??= { tagged: true }));
      },
    );
    cleanedTexts.forEach((cleanedText, index) => {
      expectDefined(parts[index], "TTS directive result part").cleanedText = cleanedText;
    });
  };

  const blockRegex = /\[\[\s*tts\s*:\s*text\s*\]\]([\s\S]*?)\[\[\s*\/\s*tts\s*:\s*text\s*\]\]/gi;
  replaceStage(blockRegex, ([inner], next) => {
    if (next.text == null) {
      next.text = String(inner).trim();
    }
    return "";
  });

  const plainBlockRegex = /\[\[\s*tts\s*\]\]([\s\S]*?)\[\[\s*\/\s*tts\s*\]\]/gi;
  replaceStage(plainBlockRegex, ([inner], next) => {
    const visible = String(inner).trim();
    if (next.text == null) {
      next.text = visible;
    }
    return visible;
  });

  const directiveRegex = /\[\[\s*tts\s*:\s*([^\]]+)\]\]/gi;
  replaceStage(directiveRegex, ([body], next) => {
    const spoken = resolveTtsDirectiveBody(String(body));
    if (spoken) {
      next.text ??= spoken;
      return spoken;
    }
    const tokens = String(body).split(/\s+/).filter(Boolean);
    let provider: string | undefined;
    const values: Record<string, string> = {};
    for (const token of tokens) {
      const eqIndex = token.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }
      const rawKey = token.slice(0, eqIndex).trim();
      const rawValue = token.slice(eqIndex + 1).trim();
      if (!rawKey || !rawValue) {
        continue;
      }
      const key = normalizeLowercaseStringOrEmpty(rawKey);
      if (key === "provider") {
        provider = normalizeLowercaseStringOrEmpty(rawValue) || undefined;
        continue;
      }
      values[key] = rawValue;
    }
    if (provider || Object.keys(values).length > 0) {
      next.directives ??= [];
      next.directives.push({ ...(provider ? { provider } : {}), values });
    }
    return "";
  });

  const bareTagRegex = /\[\[\s*tts\s*\]\]/gi;
  replaceStage(bareTagRegex, () => "");

  const closingTagRegex = /\[\[\s*\/\s*tts(?:\s*:\s*[^\]]*)?\]\]/gi;
  replaceStage(closingTagRegex, () => "");

  return parts;
}

// TRANSITIONAL(marker-retirement): the [[tts ...]] text DSL is a transitional
// adapter for automatic-mode replies; structured voiceText/voiceProvider/voiceId
// fields are canonical. Delete the DSL parse forms and this streaming cleaner
// when the visibleReplies default flips to "message_tool".
/** Streaming cleaner used to strip TTS tags before final text parsing is available. */
type TtsDirectiveTextStreamCleaner = {
  push: (text: string) => string;
  flush: () => string;
  hasBufferedDirectiveText: () => boolean;
};

function classifyTtsTag(body: string): "hidden-open" | "hidden-close" | "tts" | "other" {
  const normalized = body.trim().replace(/\s+/g, "").toLowerCase();
  if (normalized === "tts:text") {
    return "hidden-open";
  }
  if (normalized === "/tts:text") {
    return "hidden-close";
  }
  if (
    normalized === "tts" ||
    normalized.startsWith("tts:") ||
    normalized === "/tts" ||
    normalized.startsWith("/tts:")
  ) {
    return "tts";
  }
  return "other";
}

/** Create an incremental cleaner for hiding [[tts:*]] directive text while streaming. */
export function createTtsDirectiveTextStreamCleaner(): TtsDirectiveTextStreamCleaner {
  let pending = "";
  let insideHiddenTextBlock = false;
  let inlineCode = createInlineCodeState();
  let fence: FenceScanState = {};
  // Speech-only Markdown must not change the code ownership of later visible text.
  const trackVisibleText = (
    text: string,
    code = buildCodeSpanIndex(text, inlineCode, fence),
  ): string => {
    inlineCode = code.inlineState;
    fence = code.fenceState;
    return text;
  };

  return {
    push(text: string): string {
      const input = pending + text;
      pending = "";
      let output = "";
      let index = 0;

      while (index < input.length) {
        const tagStart = input.indexOf("[[", index);
        if (tagStart === -1) {
          // A chunk can end on a single "["; hold it so the next chunk can
          // complete "[[" instead of leaking markup or swallowing the rest.
          const tail = input.endsWith("[") ? input.length - 1 : input.length;
          if (!insideHiddenTextBlock) {
            output += trackVisibleText(input.slice(index, tail));
          }
          pending = input.slice(tail);
          break;
        }

        const tagEnd = input.indexOf("]]", tagStart + 2);
        if (tagEnd === -1) {
          // Directive delimiters can cross chunk boundaries; buffer from the
          // opener so a partial tag never leaks to a streamed client.
          if (!insideHiddenTextBlock) {
            output += trackVisibleText(input.slice(index, tagStart));
          }
          pending = input.slice(tagStart);
          break;
        }
        const tag = classifyTtsTag(input.slice(tagStart + 2, tagEnd));
        const keepTag = tag === "other";
        if (!insideHiddenTextBlock) {
          const segment = input.slice(index, tagEnd + 2);
          const code = buildCodeSpanIndex(segment, inlineCode, fence);
          if (code.isInside(tagStart - index)) {
            output += trackVisibleText(segment, code);
            index = tagEnd + 2;
            continue;
          }
          // A tag can be the trailing text that prevents a fence from closing.
          output += trackVisibleText(
            input.slice(index, keepTag ? tagEnd + 2 : tagStart),
            keepTag ? code : undefined,
          );
        }

        if (tag === "hidden-open") {
          insideHiddenTextBlock = true;
        } else if (tag === "hidden-close") {
          insideHiddenTextBlock = false;
        } else if (tag === "tts" && !insideHiddenTextBlock) {
          const body = /^\s*tts\s*:([\s\S]*)$/i.exec(input.slice(tagStart + 2, tagEnd))?.[1];
          if (body !== undefined) {
            output += trackVisibleText(resolveTtsDirectiveBody(body) ?? "");
          }
        }

        index = tagEnd + 2;
      }

      return output;
    },
    flush(): string {
      const tail = insideHiddenTextBlock ? "" : pending;
      pending = "";
      insideHiddenTextBlock = false;
      inlineCode = createInlineCodeState();
      fence = {};
      return tail;
    },
    hasBufferedDirectiveText(): boolean {
      return pending.length > 0 || insideHiddenTextBlock;
    },
  };
}
