import { createMemo } from "solid-js";
import {
  prepareAttachmentFileIcon,
  type AttachmentFileIconOptions,
} from "./chat-attachment-file-icon.ts";

export function AttachmentFileIcon(props: AttachmentFileIconOptions) {
  const view = createMemo(() => prepareAttachmentFileIcon(props));
  return (
    <span
      class={[
        "chat-attachment-file-icon",
        {
          "chat-attachment-file-icon--unavailable": props.unavailable,
          skeleton: props.loading,
        },
      ]}
      data-family={view().family}
      data-mode={props.mode}
      aria-hidden="true"
      style={view().style}
    >
      {view().large ? <span class="chat-attachment-file-icon__overlay" /> : null}
    </span>
  );
}
