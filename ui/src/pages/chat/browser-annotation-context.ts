import type { ChatAttachment } from "../../lib/chat/chat-types.ts";

export function composeBrowserAnnotationContext(
  userText: string,
  attachments: readonly ChatAttachment[],
): string {
  const contexts = attachments.flatMap((attachment) => {
    const context = attachment.browserAnnotation?.modelContext.trim();
    return context ? [context] : [];
  });
  return [...contexts, userText].filter(Boolean).join("\n\n");
}
