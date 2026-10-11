import type { ChatAttachment } from "../../lib/chat/chat-types.ts";

export function composeBrowserAnnotationContext(
  userText: string,
  attachments: readonly ChatAttachment[],
): string {
  const contexts = attachments.map(({ browserAnnotation }) =>
    browserAnnotation?.modelContext.trim(),
  );
  return [...contexts, userText].filter(Boolean).join("\n\n");
}
