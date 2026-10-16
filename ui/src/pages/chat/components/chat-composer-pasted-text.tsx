import { Icon } from "../../../components/solid/icon.tsx";
import { base64ToBytes } from "../../../lib/bytes-base64.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
} from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { currentAttachments, removeDraftAttachment } from "./chat-attachment-draft.ts";
import { AttachmentRemove } from "./chat-attachment-file.tsx";
import { ChatPastedText } from "./chat-pasted-text.tsx";

function readTextFromDataUrl(dataUrl: string): string | null {
  const match = /^data:([^,]*),(.*)$/s.exec(dataUrl);
  if (!match) {
    return null;
  }
  const metadata = match[1]!;
  const payload = match[2]!;
  try {
    return metadata.toLowerCase().includes(";base64")
      ? new TextDecoder().decode(base64ToBytes(payload))
      : decodeURIComponent(payload.replace(/\+/g, "%20"));
  } catch {
    return null;
  }
}

function appendPastedTextToDraft(draft: string, text: string): string {
  if (!draft.trim()) {
    return text;
  }
  return `${draft.replace(/\s+$/u, "")}\n\n${text}`;
}

function showPastedTextInComposer(att: ChatAttachment, props: ChatAttachmentControlsProps): void {
  const dataUrl = getChatAttachmentDataUrl(att);
  const text = dataUrl ? readTextFromDataUrl(dataUrl) : null;
  if (!text || !props.onDraftChange) {
    return;
  }
  removeDraftAttachment(att, props);
  props.onDraftChange(appendPastedTextToDraft(props.getDraft?.() ?? props.draft ?? "", text));
  props.onRequestUpdate?.();
}

export function ComposerPastedText(componentProps: {
  attachment: ChatAttachment;
  controls: ChatAttachmentControlsProps;
}) {
  const current = () =>
    componentProps.controls.readSignal?.aborted
      ? undefined
      : currentAttachments(componentProps.controls).find(
          (item) => item.id === componentProps.attachment.id,
        );
  const removeLabel = () =>
    componentProps.attachment.fileName?.trim()
      ? t("chat.composer.removeNamedAttachment", { name: componentProps.attachment.fileName })
      : t("chat.composer.removeAttachment");
  const remove = () => {
    if (!current() || componentProps.controls.disabled) {
      return;
    }
    removeDraftAttachment(componentProps.attachment, componentProps.controls);
  };
  const restoreAction = () => (
    <button
      class="chat-attachment-text-action"
      type="button"
      disabled={componentProps.controls.disabled}
      onClick={() => {
        const attachment = current();
        if (attachment && !componentProps.controls.disabled) {
          showPastedTextInComposer(attachment, componentProps.controls);
        }
      }}
    >
      {t("chat.attachments.showInTextField")}
    </button>
  );
  const open = () => {
    if (!current()) {
      return;
    }
    componentProps.controls.onOpenSidebar?.({
      kind: "attachment",
      attachmentKind: "document",
      title: componentProps.attachment.fileName ?? t("chat.attachments.pastedText"),
      mimeType: "text/plain",
      plainText: true,
      sourceIdentity: componentProps.attachment.id,
      resolveSource: () => {
        const attachment = current();
        if (!attachment) {
          return { status: "unavailable" };
        }
        const src = getChatAttachmentPreviewUrl(attachment);
        return src
          ? { status: "ready", src, sizeBytes: attachment.sizeBytes }
          : { status: "unavailable" };
      },
      renderActions: () => (
        <>
          {restoreAction()}
          <button
            class="btn btn--sm"
            type="button"
            aria-label={removeLabel()}
            disabled={componentProps.controls.disabled}
            onClick={remove}
          >
            <Icon name="trash" />
          </button>
        </>
      ),
    });
  };
  return (
    <ChatPastedText
      src={getChatAttachmentDataUrl(componentProps.attachment) ?? undefined}
      sizeBytes={componentProps.attachment.sizeBytes}
      scope={componentProps.attachment.id}
      onOpen={open}
      composerAction={restoreAction()}
      composerRemoveAction={
        <AttachmentRemove
          label={removeLabel()}
          disabled={componentProps.controls.disabled}
          onClick={remove}
        />
      }
    />
  );
}
