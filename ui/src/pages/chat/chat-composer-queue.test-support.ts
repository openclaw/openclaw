import { solidContent } from "../../lit/solid-content.tsx";
import { renderChatQueueSolid } from "./components/chat-composer-queue.tsx";

export function renderChatQueue(props: Parameters<typeof renderChatQueueSolid>[0]) {
  return solidContent(renderChatQueueSolid, props);
}
