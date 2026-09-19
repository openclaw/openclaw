import { html } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";

function currentAttachments(props: ChatAttachmentControlsProps): ChatAttachment[] {
  return props.getAttachments?.() ?? props.attachments ?? [];
}

function readTextFromDataUrl(dataUrl: string): string | null {
  const match = /^data:([^,]*),(.*)$/s.exec(dataUrl);
  if (!match) {
    return null;
  }
  const metadata = match[1];
  const payload = match[2];
  if (metadata === undefined || payload === undefined) {
    return null;
  }
  if (metadata.toLowerCase().includes(";base64")) {
    try {
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }
  try {
    return decodeURIComponent(payload.replace(/\+/g, "%20"));
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
  const nextAttachments = currentAttachments(props).filter(
    (attachment) => attachment.id !== att.id,
  );
  releaseChatAttachmentPayload(att.id);
  props.onAttachmentsChange?.(nextAttachments);
  props.onDraftChange(appendPastedTextToDraft(props.getDraft?.() ?? props.draft ?? "", text));
  props.onRequestUpdate?.();
}

export function renderComposerPastedText(att: ChatAttachment, props: ChatAttachmentControlsProps) {
  const current = () =>
    props.readSignal?.aborted
      ? undefined
      : currentAttachments(props).find((item) => item.id === att.id);
  const removeLabel = att.fileName?.trim()
    ? t("chat.composer.removeNamedAttachment", { name: att.fileName })
    : t("chat.composer.removeAttachment");
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
      renderActions: () => html`<button
          class="chat-attachment-text-action"
          type="button"
          ?disabled=${props.disabled}
          @click=${() => {
            const attachment = current();
            if (attachment && !props.disabled) {
              showPastedTextInComposer(attachment, props);
            }
          }}
        >
          ${t("chat.attachments.showInTextField")}
        </button>
        <button
          class="btn btn--sm"
          type="button"
          aria-label=${removeLabel}
          ?disabled=${props.disabled}
          @click=${() => {
            if (current() && !props.disabled) {
              const next = currentAttachments(props).filter((item) => item.id !== att.id);
              releaseChatAttachmentPayload(att.id);
              props.onAttachmentsChange?.(next);
            }
          }}
        >
          ${icons.trash}
        </button>`,
    });
  };
  return html`<openclaw-chat-pasted-text
    .src=${getChatAttachmentDataUrl(att)}
    .sizeBytes=${att.sizeBytes}
    .scope=${att.id}
    .onOpen=${open}
  ></openclaw-chat-pasted-text>`;
}
