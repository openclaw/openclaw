import { t } from "../../lib/reactive/i18n.ts";

export function describeChatQueueAttachmentLabels(labels: readonly string[]): string {
  const annotations = labels.filter((label) => label === "selection-comment.txt").length;
  const descriptions = labels.filter((label) => label !== "selection-comment.txt");
  if (annotations) {
    descriptions.unshift(
      t(annotations === 1 ? "chat.queue.annotationCount" : "chat.queue.annotationsCount", {
        count: String(annotations),
      }),
    );
  }
  return descriptions.join(", ");
}
