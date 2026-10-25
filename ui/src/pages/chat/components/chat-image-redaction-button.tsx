import { lazy } from "solid-js";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";
import { getChatAttachmentBlob } from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";

const RedactionDialog = lazy(() => import("./chat-image-redaction-dialog.tsx"), {
  export: "ImageRedaction",
});

export function ImageRedactionButton(props: {
  attachment: ChatAttachment;
  controls: ChatAttachmentControlsProps;
}) {
  let editing = false;
  const redact = async () => {
    if (editing || props.controls.disabled) {
      return;
    }
    const original = props.attachment;
    const signal = props.controls.readSignal ?? props.controls.attachmentReads?.readSignal;
    const blob = getChatAttachmentBlob(original);
    if (!blob) {
      return;
    }
    editing = true;
    try {
      const [{ showImageRedaction }, { replaceRedactedAttachment }] = await Promise.all([
        RedactionDialog.preload(),
        import("./chat-image-redaction.ts"),
      ]);
      if (
        props.controls.disabled ||
        signal?.aborted ||
        signal !== (props.controls.readSignal ?? props.controls.attachmentReads?.readSignal)
      ) {
        return;
      }
      const result = await showImageRedaction(blob, signal);
      if (
        result &&
        !signal?.aborted &&
        signal === (props.controls.readSignal ?? props.controls.attachmentReads?.readSignal)
      ) {
        replaceRedactedAttachment(original, result, props.controls);
      }
    } catch {
      if (!signal?.aborted) {
        showToast({ message: t("chat.attachments.redactionFailed"), severity: "error" });
      }
    } finally {
      editing = false;
    }
  };
  return (
    <button
      type="button"
      class="chat-attachment-redact"
      style={{
        position: "absolute",
        "inset-inline": 0,
        bottom: 0,
        border: 0,
        padding: "0.25rem",
        background: "var(--bg-elevated)",
        color: "var(--text)",
        "font-size": "0.7rem",
      }}
      disabled={props.controls.disabled}
      aria-label={t("chat.attachments.redactImage")}
      title={t("chat.attachments.redactImage")}
      onClick={() => void redact()}
    >
      {t("chat.attachments.redactImage")}
    </button>
  );
}
