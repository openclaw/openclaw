import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isAssistantTextContentBlockType,
  normalizeAssistantPhase,
  parseAssistantTextSignature,
} from "../chat-message-content.js";
import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { toolCallXmlTextFilter } from "./tool-call-xml.js";

/** Display-only text groups; the source message and native calls remain unchanged. */
export function findNativeToolMarkerTextBlocks(message: unknown): ReadonlySet<number> {
  const hidden = new Set<number>();
  const entry = asOptionalRecord(message);
  if (
    entry?.role !== "assistant" ||
    normalizeAssistantPhase(entry.phase) ||
    !Array.isArray(entry.content)
  ) {
    return hidden;
  }
  let start = 0;
  let text = "";
  let markdownPrefix = "";
  let phased = false;
  for (let index = 0; index <= entry.content.length; index++) {
    const block = asOptionalRecord(entry.content[index]);
    if (block && isAssistantTextContentBlockType(block.type) && typeof block.text === "string") {
      text += block.text;
      phased ||= Boolean(parseAssistantTextSignature(block)?.phase);
      continue;
    }
    if (
      block?.type === "toolCall" &&
      !phased &&
      text.includes("<") &&
      !toolCallXmlTextFilter({ stripFunctionCallsXmlPayloads: true }, true)
        .transform(text.trimEnd())
        .trim() &&
      !isInsideCode(
        markdownPrefix.length + text.indexOf("<"),
        findCodeRegions(markdownPrefix + text),
      )
    ) {
      for (let textIndex = start; textIndex < index; textIndex++) {
        hidden.add(textIndex);
      }
    }
    // Markdown context crosses native blocks, but explicit phases own separate text.
    markdownPrefix = phased ? "" : `${markdownPrefix}${text}\n`;
    start = index + 1;
    text = "";
    phased = false;
  }
  return hidden;
}
