import { solidContent } from "../../../lit/solid-content.tsx";
import {
  MessageActions,
  ReplyButton,
  type MessageActionDetails,
  type MessageReplyTarget,
  type renderSolidMessageActionButtons,
} from "./chat-message-markdown-view.tsx";
export * from "./chat-message-markdown-view.tsx";

export function renderMessageActionButtons(
  details: MessageActionDetails | null | undefined,
  options: Parameters<typeof renderSolidMessageActionButtons>[1],
) {
  return solidContent(MessageActions, { details, options });
}

export function renderReplyButton(
  target: MessageReplyTarget,
  onReply: (target: MessageReplyTarget) => void,
) {
  return solidContent(ReplyButton, { target, onReply });
}
