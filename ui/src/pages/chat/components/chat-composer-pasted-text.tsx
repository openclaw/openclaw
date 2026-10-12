import { icons } from "../../../components/icons.ts";
import { base64ToBytes } from "../../../lib/bytes-base64.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
} from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { currentAttachments, removeDraftAttachment } from "./chat-attachment-draft.ts";
import { renderAttachmentRemove } from "./chat-attachment-file.ts";
import { solidTemplate } from "./chat-composer-controls.ts";
import { LitContent } from "./chat-composer-interop.tsx";

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

export function renderComposerPastedTextSolid(
  att: ChatAttachment,
  props: ChatAttachmentControlsProps,
) {
  const current = () =>
    props.readSignal?.aborted
      ? undefined
      : currentAttachments(props).find((item) => item.id === att.id);
  const removeLabel = att.fileName?.trim()
    ? t("chat.composer.removeNamedAttachment", { name: att.fileName })
    : t("chat.composer.removeAttachment");
  const remove = () => {
    if (!current() || props.disabled) {
      return;
    }
    removeDraftAttachment(att, props);
  };
  const restoreAction = () => (
    <button
      class="chat-attachment-text-action"
      type="button"
      disabled={props.disabled}
      onClick={() => {
        const attachment = current();
        if (attachment && !props.disabled) {
          showPastedTextInComposer(attachment, props);
        }
      }}
    >
      {t("chat.attachments.showInTextField")}
    </button>
  );
  const renderRestoreAction = () => solidTemplate(restoreAction, {});
  const open = () => {
    if (!current()) {
      return;
    }
    props.onOpenSidebar?.({
      kind: "attachment",
      attachmentKind: "document",
      title: att.fileName ?? t("chat.attachments.pastedText"),
      mimeType: "text/plain",
      plainText: true,
      sourceIdentity: att.id,
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
      renderActions: () =>
        solidTemplate(
          () => (
            <>
              {restoreAction()}
              <button
                class="btn btn--sm"
                type="button"
                aria-label={removeLabel}
                disabled={props.disabled}
                onClick={remove}
              >
                <LitContent value={icons.trash} />
              </button>
            </>
          ),
          {},
        ),
    });
  };
  return (
    <openclaw-chat-pasted-text
      prop:src={getChatAttachmentDataUrl(att) ?? undefined}
      prop:sizeBytes={att.sizeBytes}
      prop:scope={att.id}
      prop:onOpen={open}
      prop:composerAction={renderRestoreAction()}
      prop:composerRemoveAction={renderAttachmentRemove(removeLabel, props.disabled, remove)}
    ></openclaw-chat-pasted-text>
  );
}

function renderComposerPastedTextContent(props: {
  args: Parameters<typeof renderComposerPastedTextSolid>;
}) {
  return <>{renderComposerPastedTextSolid(...props.args)}</>;
}

export function renderComposerPastedText(
  ...args: Parameters<typeof renderComposerPastedTextSolid>
) {
  return solidTemplate(renderComposerPastedTextContent, { args });
}
