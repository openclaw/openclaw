import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { AssistantDeliveryTtsFacts } from "../llm/types.js";
import { replaceOutsideCodeRegionParts } from "../utils/directive-tags.js";

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
