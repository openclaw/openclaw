import { solidContent } from "../../../lit/solid-content.tsx";
import { MessageWorkContext } from "./chat-message-context-view.tsx";
export * from "./chat-message-context-view.tsx";

export function renderMessageWorkContext(message: unknown) {
  return solidContent(MessageWorkContext, { message });
}
