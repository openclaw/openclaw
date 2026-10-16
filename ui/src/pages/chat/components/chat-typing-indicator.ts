import { solidContent } from "../../../lit/solid-content.tsx";
import type { ChatTypingActorView, ChatTypingOverflow } from "../chat-typing-presence.ts";
import { ChatTypingIndicator } from "./chat-typing-indicator.tsx";

export function renderChatTypingIndicator(
  actors: readonly ChatTypingActorView[] | undefined,
  avatarPlacement: "gutter" | "footer" | "none" = "gutter",
  overflow?: ChatTypingOverflow,
) {
  return actors?.length
    ? solidContent(ChatTypingIndicator, { actors, avatarPlacement, overflow })
    : null;
}
