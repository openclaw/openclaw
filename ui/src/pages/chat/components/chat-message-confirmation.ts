import { solidContent } from "../../../lit/solid-content.tsx";
import { RewindButton } from "./chat-message-confirmation-view.tsx";
export * from "./chat-message-confirmation-view.tsx";

export function renderRewindButton(onRewind: () => void) {
  return solidContent(RewindButton, { onRewind });
}
