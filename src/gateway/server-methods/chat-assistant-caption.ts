import {
  sanitizeAssistantDisplayText,
  type AssistantDisplayContentBlock,
} from "./chat-assistant-content.js";

/**
 * Delivered text blocks carrying the authored caption. A native CLI mirror's block may
 * start with earlier narration, and delivery may append the usage footer after it.
 */
export function findAssistantCaptionBlocks(params: {
  content: AssistantDisplayContentBlock[];
  caption: string;
  nativeMirror: boolean;
  usageLine?: string;
}) {
  const suffix = params.usageLine ? `\n${params.usageLine}` : "";
  let usage = "";
  const blocks = params.content.filter((block) => {
    const delivered = block.type === "text" && typeof block.text === "string" ? block.text : "";
    const hasUsage = Boolean(suffix) && delivered.endsWith(suffix);
    const text = sanitizeAssistantDisplayText(
      hasUsage ? delivered.slice(0, -suffix.length) : delivered,
    );
    const matched =
      text === params.caption ||
      (params.nativeMirror && text?.endsWith(`\n${params.caption}`) === true);
    if (matched && hasUsage) {
      usage = suffix;
    }
    return matched;
  });
  return { blocks, usage };
}

/** Keeps a consumed usage footer under the rebuilt caption. */
export function appendCaptionUsage(content: AssistantDisplayContentBlock[], usage: string) {
  const index = usage
    ? content.findLastIndex((block) => block.type === "text" && typeof block.text === "string")
    : -1;
  const block = content[index];
  if (block) {
    const { textSignature: _textSignature, ...rest } = block;
    content[index] = { ...rest, text: `${String(block.text).trimEnd()}${usage}` };
  }
}
