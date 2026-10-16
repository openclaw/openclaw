import { solidContent } from "../../../lit/solid-content.tsx";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { ChatSelectionAnnotations } from "./chat-selection-annotations.tsx";

export { dispatchChatCommentAction } from "./chat-selection-annotations.tsx";

/** The persistent comment owner handles edits from either preview or source marker. */
export function renderChatSelectionAnnotations(props: ChatAttachmentControlsProps) {
  return solidContent(ChatSelectionAnnotations, props);
}
