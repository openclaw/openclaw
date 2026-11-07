import { lazy, onSettled } from "solid-js";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import { getChatAttachmentBlob } from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { currentAttachments } from "./chat-attachment-draft.ts";

const RedactionDialog = lazy(() => import("./chat-image-redaction-dialog.tsx"), {
  export: "ImageRedaction",
});

export function ImageRedactionButton(props: {
  attachment: ChatAttachment;
  controls: ChatAttachmentControlsProps;
}) {
  let editController: AbortController | undefined;
  onSettled(() => () => editController?.abort());
  const redact = async () => {
    if (editController || props.controls.disabled) {
      return;
    }
    const original = props.attachment;
    const signal = props.controls.readSignal ?? props.controls.attachmentReads?.readSignal;
    const blob = getChatAttachmentBlob(original);
    if (!blob) {
      return;
    }
    const controller = new AbortController();
    editController = controller;
    const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const isCurrent = () =>
      !lifetime.aborted &&
      signal === (props.controls.readSignal ?? props.controls.attachmentReads?.readSignal) &&
      props.attachment === original &&
      props.controls.cameraActive !== false &&
      currentAttachments(props.controls).includes(original);
    const canApply = () => !props.controls.disabled && uploadsEnabled(props.controls.uploadConfig);
    const failed = () => {
      if (isCurrent()) {
        showToast({ message: t("chat.attachments.redactionFailed"), severity: "error" });
      }
    };
    try {
      const [{ showImageRedaction }, { replaceRedactedAttachment }] = await Promise.all([
        RedactionDialog.preload(),
        import("./chat-image-redaction.ts"),
      ]);
      if (!isCurrent() || !canApply()) {
        return;
      }
      await showImageRedaction(blob, {
        signal: lifetime,
        isCurrent,
        canApply,
        apply: (result) => {
          try {
            return isCurrent() && replaceRedactedAttachment(original, result, props.controls);
          } catch {
            failed();
            return false;
          }
        },
      });
    } catch {
      failed();
    } finally {
      editController = undefined;
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
