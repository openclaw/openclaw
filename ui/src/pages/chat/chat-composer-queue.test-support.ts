import { solidTemplate } from "./components/chat-composer-controls.ts";
import { renderChatQueueSolid } from "./components/chat-composer-queue.tsx";

export function renderChatQueue(props: Parameters<typeof renderChatQueueSolid>[0]) {
  return solidTemplate(renderChatQueueSolid, props);
}
