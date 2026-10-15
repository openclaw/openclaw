import { solidContent } from "../../../lit/solid-content.tsx";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { ChatAttachmentInputs } from "./chat-attachment-inputs.tsx";
import { AttachmentPreview } from "./chat-attachments.tsx";

// Existing Lit composer fixtures mount the production Solid views through the same interop boundary.
export function renderAttachmentPreview(props: ChatAttachmentControlsProps) {
  return solidContent(AttachmentPreview, props);
}

export function renderChatAttachmentInputs(props: ChatAttachmentControlsProps) {
  return solidContent(ChatAttachmentInputs, props);
}
