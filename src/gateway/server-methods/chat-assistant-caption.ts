import { splitMediaFromOutput } from "../../media/parse.js";
import {
  sanitizeAssistantDisplayText,
  type AssistantDisplayContentBlock,
} from "./chat-assistant-content.js";

/** Compare authored captions without transport directives or the known delivery footer. */
export function normalizeAssistantMediaCaption(text: string, usageLine?: string) {
  const caption =
    usageLine && text.endsWith(`\n${usageLine}`) ? text.slice(0, -usageLine.length - 1) : text;
  return sanitizeAssistantDisplayText(splitMediaFromOutput(caption).text);
}

export function retainCaptionUsageLine(
  content: AssistantDisplayContentBlock[],
  matchingCaptions: AssistantDisplayContentBlock[],
  usageLine?: string,
) {
  // The footer belongs to delivery, not the native message; retain it in display only.
  if (
    usageLine &&
    matchingCaptions.some(
      (block) => typeof block.text === "string" && block.text.endsWith(`\n${usageLine}`),
    )
  ) {
    const index = content.findLastIndex(
      (block) => block.type === "text" && typeof block.text === "string",
    );
    const caption = content[index];
    if (caption && typeof caption.text === "string") {
      const { textSignature: _textSignature, ...rest } = caption;
      content[index] = { ...rest, text: `${caption.text.trimEnd()}\n${usageLine}` };
    }
  }
}

export function findMatchingAssistantCaptions(
  content: AssistantDisplayContentBlock[],
  joinedCaption: string,
  nativeMirror: boolean,
  usageLine?: string,
) {
  return content.filter((block) => {
    const caption =
      block.type === "text" && typeof block.text === "string"
        ? normalizeAssistantMediaCaption(block.text, usageLine)
        : undefined;
    return (
      caption === joinedCaption ||
      (nativeMirror && caption?.endsWith(`\n${joinedCaption}`) === true)
    );
  });
}
