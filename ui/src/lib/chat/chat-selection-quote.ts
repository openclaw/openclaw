import type { ChatSelectionAnnotation } from "./chat-types.ts";

/** Quotes a transcript selection, followed by its comment, as message text. */
export function formatChatSelectionQuote(annotation: ChatSelectionAnnotation): string {
  const quote = annotation.text
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  const comment = annotation.comment.trim();
  return comment ? `${quote}\n\n${comment}` : quote;
}
