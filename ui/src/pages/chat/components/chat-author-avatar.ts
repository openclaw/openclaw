import type { ChannelSenderAvatarSource } from "../../../lib/chat/channel-sender-avatar.ts";
import { formatSenderLabel } from "../../../lib/chat/sender-label.ts";
import type { IdentityAvatarInput } from "../../../lib/identity-avatar.ts";
import { emptyLegacyContent, solidContent } from "../../../lit/solid-content.tsx";
import { ChatAuthorAvatar } from "./chat-author-avatar-view.tsx";

export { ChatAuthorAvatar, UserAvatarSlot } from "./chat-author-avatar-view.tsx";

/** Adapter for the remaining Lit transcript and reply templates. */
export function renderChatAuthorAvatar(
  sender: IdentityAvatarInput | null | undefined,
  className = "chat-author-avatar",
  agentAvatar?: { avatar?: string | null; textAvatar?: string | null },
  channelAvatar?: ChannelSenderAvatarSource,
) {
  if (!sender || !formatSenderLabel(sender)) {
    return emptyLegacyContent;
  }
  return solidContent(ChatAuthorAvatar, { sender, class: className, agentAvatar, channelAvatar });
}

export function resolveChatDefaultAvatarPlacement(
  isDirectSession: boolean,
  userId?: string | null,
): "footer" | "gutter" {
  return isDirectSession && !userId ? "footer" : "gutter";
}
