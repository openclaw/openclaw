import { emptyLegacyContent, solidContent } from "../../../lit/solid-content.tsx";
import {
  canManageChatSessionSharing,
  ChatSessionPublicIndicator,
  ChatSessionSharing,
  type ChatSessionSharingProps,
} from "./chat-session-sharing.solid.tsx";
export {
  canManageChatSessionSharing,
  selectChatSessionSharingItem,
  type ChatSessionSharingProps,
  type ChatSessionSharingState,
} from "./chat-session-sharing.solid.tsx";

export function renderChatSessionPublicIndicator(props: ChatSessionSharingProps) {
  if (!props.state?.result?.publicShare) {
    return emptyLegacyContent;
  }
  return solidContent(ChatSessionPublicIndicator, props);
}

export function renderChatSessionSharing(props: ChatSessionSharingProps, inline = false) {
  if (
    !props.session ||
    (!canManageChatSessionSharing(props.session) && props.session.visibility !== "draft")
  ) {
    return emptyLegacyContent;
  }
  return solidContent(ChatSessionSharing, { ...props, inline });
}
