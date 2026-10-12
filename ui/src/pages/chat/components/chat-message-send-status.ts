import { solidContent } from "../../../lit/solid-content.tsx";
import {
  ChatSendStatus,
  type renderSolidChatSendStatus,
} from "./chat-message-send-status-view.tsx";
export * from "./chat-message-send-status-view.tsx";

export function renderChatSendStatus(...args: Parameters<typeof renderSolidChatSendStatus>) {
  return solidContent(ChatSendStatus, { status: args[0], actions: args[1] });
}
