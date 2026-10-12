import { solidContent } from "../../../lit/solid-content.tsx";
import { ChatTimestamp, type renderSolidChatTimestamp } from "./chat-message-timestamp-view.tsx";
export * from "./chat-message-timestamp-view.tsx";

export function renderChatTimestamp(...args: Parameters<typeof renderSolidChatTimestamp>) {
  return solidContent(ChatTimestamp, { timestamp: args[0], metadata: args[1] });
}
