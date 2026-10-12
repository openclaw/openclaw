import { solidContent } from "../../../lit/solid-content.tsx";
import {
  ChatTimestamp,
  MessageMeta,
  type renderSolidChatTimestamp,
  type renderSolidMessageMeta,
} from "./chat-message-timestamp-view.tsx";
export * from "./chat-message-timestamp-view.tsx";

export function renderChatTimestamp(...args: Parameters<typeof renderSolidChatTimestamp>) {
  return solidContent(ChatTimestamp, { timestamp: args[0], metadata: args[1] });
}

export function renderMessageMeta(...args: Parameters<typeof renderSolidMessageMeta>) {
  return solidContent(MessageMeta, { timestamp: args[0], meta: args[1] });
}
