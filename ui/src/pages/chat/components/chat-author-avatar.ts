export { ChatAuthorAvatar, UserAvatarSlot } from "./chat-author-avatar-view.tsx";

export function resolveChatDefaultAvatarPlacement(
  isDirectSession: boolean,
  userId?: string | null,
): "footer" | "gutter" {
  return isDirectSession && !userId ? "footer" : "gutter";
}
