import { createMemo, lazy, Loading, Show } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import type { ChatAttachmentRead } from "./chat-attachment-reads.ts";

// Keep preview-only rendering out of empty composers, including New Session.
const AttachmentPreviewStrip = lazy(() => import("./chat-attachment-preview-strip.tsx"), {
  export: "AttachmentPreviewStrip",
});

// Keep the live region mounted so changes in the number of files are announced.
export function AttachmentReadStatus(props: { pendingReads: number }) {
  return (
    <div
      class="chat-attachments-status sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {props.pendingReads > 0
        ? t(
            props.pendingReads === 1
              ? "chat.composer.preparingAttachmentCount"
              : "chat.composer.preparingAttachmentsCount",
            { count: String(props.pendingReads) },
          )
        : undefined}
    </div>
  );
}

export type AttachmentPreviewEntry = Pick<
  ChatAttachmentRead,
  "attachment" | "state" | "progress" | "preparation"
> & {
  read: ChatAttachmentRead;
};

export function AttachmentPreview(
  props: ChatAttachmentControlsProps & { readRevision?: number | object },
) {
  const entries = createMemo(() => {
    void props.readRevision;
    const attachments = props.attachments ?? [];
    const reads =
      props.attachmentReads?.project(attachments) ??
      attachments.map((attachment): ChatAttachmentRead => ({ attachment, state: "ready" }));
    return reads.map((read): AttachmentPreviewEntry => ({
      read,
      attachment: read.attachment,
      state: read.state,
      progress: read.progress,
      preparation: read.preparation,
    }));
  });
  return (
    <Show when={entries().length > 0}>
      <Loading>
        <AttachmentPreviewStrip entries={entries()} controls={props} />
      </Loading>
    </Show>
  );
}
