import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function isChatSendReconnecting(
  state: ChatQueueItem["sendState"],
  connected: boolean | undefined,
): boolean {
  // Delivery versions retain this state for recovery and captured edits. A
  // restart ack may briefly precede the socket close; connection owns the label.
  return state === "waiting-reconnect" && connected !== true;
}

export function describeChatQueueAttachmentLabels(
  labels: readonly (string | undefined)[],
  imageCount = 0,
): string {
  let annotations = 0;
  const descriptions: string[] = [];
  for (const label of labels) {
    if (label === "selection-comment.txt") {
      annotations += 1;
    } else if (label) {
      descriptions.push(label);
    }
  }
  if (annotations) {
    descriptions.unshift(
      t(annotations === 1 ? "chat.queue.annotationCount" : "chat.queue.annotationsCount", {
        count: String(annotations),
      }),
    );
  }
  return (
    descriptions.join(", ") ||
    (imageCount ? t("chat.queue.imageCount", { count: String(imageCount) }) : "")
  );
}
