// Shared attachment controls for chat and new-session composers.
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../../../components/icons.ts";
import { scrollState } from "../../../components/scroll-state.ts";
import "../../../components/tooltip.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import type { BrowserAnnotationAttachment, ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { showToast } from "../../../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../../lib/uploads.ts";
import {
  generateAttachmentId,
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { admitAttachmentFiles, chatAttachmentBatchBytes } from "./chat-attachment-admission.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { currentAttachments, removeDraftAttachment } from "./chat-attachment-draft.ts";
import { renderAttachmentFileIcon } from "./chat-attachment-file-icon.ts";
import { renderCompactAttachmentFile } from "./chat-attachment-file.ts";
import { dataImageClipboardFile } from "./chat-attachment-image.ts";
import {
  ChatAttachmentReadLifecycle,
  type ChatAttachmentRead,
  readChatAttachmentFile,
} from "./chat-attachment-reads.ts";
import { encodeTextAsDataUrl } from "./chat-attachment-text.ts";
import { renderComposerPastedText } from "./chat-composer-pasted-text.ts";
import { isPastedTextAttachment } from "./chat-pasted-text.ts";
import { renderChatSelectionAnnotations } from "./chat-selection-annotations.ts";

const LARGE_PASTE_TEXT_THRESHOLD = 1000;

function isFileDrag(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

const TEXT_ENTRY_INPUT_TYPES = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

// Native text/URL drop insertion is only meaningful on controls that can
// actually accept it; anywhere else (disabled/readonly inputs, non-text
// controls like checkbox/range) an uncancelled URL drop navigates the app
// away and discards unsent drafts.
function isEditableDropTarget(event: DragEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) {
    return false;
  }
  const editable = target.closest("textarea, input, [contenteditable]");
  if (editable instanceof HTMLInputElement) {
    return TEXT_ENTRY_INPUT_TYPES.has(editable.type) && !editable.disabled && !editable.readOnly;
  }
  if (editable instanceof HTMLTextAreaElement) {
    return !editable.disabled && !editable.readOnly;
  }
  return editable instanceof HTMLElement && editable.isContentEditable;
}

/** Decoded bytes already committed to the next send: ready attachments plus in-flight reads. */
export function stagedAttachmentBytes(
  props: ChatAttachmentControlsProps,
  attachments: readonly ChatAttachment[] = currentAttachments(props),
): number {
  return (
    chatAttachmentBatchBytes(attachments) +
    (props.attachmentReads?.pendingBytes(props.attachmentLimits) ?? 0)
  );
}

function chatAttachmentFromFile(
  file: File,
  dataUrl: string,
  origin: ChatAttachment["origin"] = "file",
): ChatAttachment {
  const attachment = {
    id: generateAttachmentId(),
    origin,
    mimeType: file.type || "application/octet-stream",
    fileName: file.name || undefined,
    sizeBytes: file.size,
  };
  return registerChatAttachmentPayload({ attachment, dataUrl, file });
}

export function chatAttachmentFromDataUrl(
  dataUrl: string,
  fileName: string,
  limits: ChatAttachmentControlsProps["attachmentLimits"],
  stagedBytes: number,
): ChatAttachment | null {
  const baseName = fileName.replace(/\.[a-z0-9]+$/i, "") || "image";
  const parsed = dataImageClipboardFile(dataUrl, baseName);
  if (!parsed || admitAttachmentFiles([parsed.file], limits, stagedBytes).length === 0) {
    return null;
  }
  return chatAttachmentFromFile(parsed.file, parsed.dataUrl);
}

export function appendChatAttachmentFiles(
  candidates: readonly File[],
  props: ChatAttachmentControlsProps,
): number {
  if (!props.onAttachmentsChange || candidates.length === 0 || props.readSignal?.aborted) {
    return 0;
  }
  if (!uploadsEnabled(props.uploadConfig)) {
    showToast({ message: uploadsDisabledMessage() });
    return 0;
  }
  const unsupported = props.imagesOnly
    ? candidates.filter((file) => !file.type.startsWith("image/"))
    : [];
  if (unsupported.length) {
    showToast({ message: t("chat.attachments.imagesOnly") });
  }
  const stagedBytes = stagedAttachmentBytes(props);
  const files = admitAttachmentFiles(
    candidates.filter((file) => !unsupported.includes(file)),
    props.attachmentLimits,
    stagedBytes,
    { resizeImages: true },
  );
  if (files.length === 0) {
    return 0;
  }
  const reads =
    props.attachmentReads ?? new ChatAttachmentReadLifecycle(() => props.onRequestUpdate?.());
  const entries = reads.begin(files, currentAttachments(props), {
    getAttachments: () => currentAttachments(props),
    onAttachmentsChange: props.onAttachmentsChange,
    onPendingReadsChange: props.onPendingReadsChange,
  });
  entries.forEach((entry, index) => {
    const file = files[index];
    if (file) {
      readChatAttachmentFile(file, entry, reads, props);
    }
  });
  return files.length;
}

export function handleChatAttachmentPaste(
  e: ClipboardEvent,
  props: ChatAttachmentControlsProps,
  options: { imagesOnly?: boolean } = {},
) {
  if (!e.clipboardData || !props.onAttachmentsChange) {
    return;
  }
  if (!uploadsEnabled(props.uploadConfig)) {
    const hasFiles = Array.from(e.clipboardData.items ?? []).some(
      (item) => item.kind === "file" || item.type.startsWith("image/"),
    );
    const hasInlineImage = /^data:image\//i.test(e.clipboardData.getData("text/plain").trim());
    if (hasFiles || hasInlineImage) {
      e.preventDefault();
      showToast({ message: uploadsDisabledMessage() });
    }
    // Large text remains ordinary native paste instead of becoming a file.
    return;
  }
  const imageFiles = Array.from(e.clipboardData.items ?? [])
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const text = imageFiles.length === 0 ? e.clipboardData.getData("text/plain") : undefined;
  const pasted = text ? dataImageClipboardFile(text) : null;
  if (pasted) {
    imageFiles.push(pasted.file);
  }
  if (imageFiles.length === 0) {
    if (options.imagesOnly || !text || text.length <= LARGE_PASTE_TEXT_THRESHOLD) {
      return;
    }
    e.preventDefault();
    const file = new File([text], `pasted-text-${Date.now()}.txt`, { type: "text/plain" });
    const stagedBytes = stagedAttachmentBytes(props);
    if (admitAttachmentFiles([file], props.attachmentLimits, stagedBytes).length === 0) {
      // The rejection toast named the file; the clipboard still holds the text.
      return;
    }
    const attachment = chatAttachmentFromFile(file, encodeTextAsDataUrl(text), "paste");
    props.onAttachmentsChange([...currentAttachments(props), attachment]);
    return;
  }
  e.preventDefault();
  if (
    pasted &&
    (!props.attachmentLimits || pasted.file.size <= props.attachmentLimits.maxImageBytes)
  ) {
    const stagedBytes = stagedAttachmentBytes(props);
    if (admitAttachmentFiles([pasted.file], props.attachmentLimits, stagedBytes).length === 0) {
      return;
    }
    props.onAttachmentsChange([
      ...currentAttachments(props),
      chatAttachmentFromFile(pasted.file, pasted.dataUrl),
    ]);
    return;
  }
  appendChatAttachmentFiles(imageFiles, props);
}

type ChatAttachmentDropProps = ChatAttachmentControlsProps & {
  canCompose: boolean;
};

// Both composers share balanced nested drag state and cancel non-editable
// text/URL drops so disabled surfaces cannot navigate away from a draft.
export function createChatAttachmentDropHandlers(props: ChatAttachmentDropProps) {
  let depth = 0;
  const setActive = (event: DragEvent, active: boolean) => {
    if (isFileDrag(event.dataTransfer)) {
      event.stopPropagation();
    }
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (active) {
      if (
        !props.canCompose ||
        !uploadsEnabled(props.uploadConfig) ||
        !isFileDrag(event.dataTransfer)
      ) {
        return;
      }
      depth += 1;
    } else {
      depth = Math.max(0, depth - 1);
    }
    target.toggleAttribute("data-attachment-drop-active", depth > 0);
  };
  const clearActive = (event: DragEvent) => {
    depth = 0;
    const target = event.currentTarget;
    if (target instanceof HTMLElement) {
      target.removeAttribute("data-attachment-drop-active");
    }
  };
  return {
    onDragenter: (event: DragEvent) => setActive(event, true),
    onDragleave: (event: DragEvent) => setActive(event, false),
    onDragover: (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) {
        if (!isEditableDropTarget(event)) {
          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "none";
          }
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect =
          props.canCompose && uploadsEnabled(props.uploadConfig) ? "copy" : "none";
      }
    },
    onDrop: (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) {
        if (!isEditableDropTarget(event)) {
          event.preventDefault();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearActive(event);
      if (props.canCompose) {
        appendChatAttachmentFiles([...(event.dataTransfer?.files ?? [])], props);
      }
    },
  };
}

function renderAttachmentImage(
  attachment: ChatAttachment,
  alt: string,
  title: string,
  props: ChatAttachmentControlsProps,
): ReturnType<typeof html> | typeof nothing {
  const src = getChatAttachmentPreviewUrl(attachment);
  if (!src) {
    return nothing;
  }
  if (!props.onOpenImage) {
    return html`<img src=${src} alt=${alt} />`;
  }
  const open = () => props.onOpenImage?.({ src, title });
  return html`
    <button
      type="button"
      class="chat-message-image-button chat-attachment-image-button"
      aria-label=${t("chat.imageLightbox.open", { title })}
      @click=${open}
    >
      <img src=${src} alt=${alt} />
    </button>
  `;
}

function renderBrowserAnnotationAttachment(
  attachment: ChatAttachment,
  annotation: BrowserAnnotationAttachment,
  props: ChatAttachmentControlsProps,
) {
  const identity =
    annotation.title.trim() ||
    annotation.displayUrl.trim() ||
    attachment.fileName ||
    t("chat.attachments.attachedFile");
  const regionLabel = t(
    annotation.markedRegionCount === 1
      ? "chat.composer.browserAnnotationRegion"
      : "chat.composer.browserAnnotationRegions",
    { count: String(annotation.markedRegionCount) },
  );
  const removeLabel = t("chat.composer.removeBrowserAnnotation", { name: identity });

  return html`
    <div
      class="chat-attachment-thumb chat-attachment-thumb--browser-annotation"
      data-attachment-id=${attachment.id}
      role="group"
      aria-label=${`${t("chat.composer.browserAnnotation")}: ${identity}`}
    >
      <div class="chat-browser-annotation-card__preview">
        ${renderAttachmentImage(
          attachment,
          t("chat.composer.browserAnnotationPreview"),
          identity,
          props,
        )}
      </div>
      <div class="chat-attachment-file__body chat-browser-annotation-card__body">
        <span
          class="chat-attachment-file__name chat-browser-annotation-card__identity"
          title=${identity}
          >${identity}</span
        >
        <span class="chat-attachment-file__meta chat-browser-annotation-card__meta">
          <span>${regionLabel}</span>
        </span>
      </div>
      <openclaw-tooltip .content=${removeLabel}>
        <button
          class="chat-attachment-remove chat-browser-annotation-card__remove"
          type="button"
          aria-label=${removeLabel}
          ?disabled=${props.disabled}
          @click=${() =>
            props.onRemoveAttachment
              ? props.onRemoveAttachment(attachment)
              : removeDraftAttachment(attachment, props)}
        >
          ${icons.x}
        </button>
      </openclaw-tooltip>
    </div>
  `;
}

// Keep the live region mounted so changes in the number of files are announced.
export function renderAttachmentReadStatus(pendingReads: number) {
  return html`<div
    class="chat-attachments-status sr-only"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    ${
      pendingReads > 0
        ? t(
            pendingReads === 1
              ? "chat.composer.preparingAttachmentCount"
              : "chat.composer.preparingAttachmentsCount",
            { count: String(pendingReads) },
          )
        : nothing
    }
  </div>`;
}

export function renderAttachmentPreview(props: ChatAttachmentControlsProps) {
  const attachments = props.attachments ?? [];
  const entries =
    props.attachmentReads?.project(attachments) ??
    attachments.map((attachment): ChatAttachmentRead => ({ attachment, state: "ready" }));
  if (entries.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-attachments-preview" ${scrollState(true)}>
      ${renderChatSelectionAnnotations(props)}
      ${repeat(
        entries.filter(({ attachment }) => !attachment.selectionAnnotation),
        ({ attachment }) => attachment.id,
        (entry) => {
          const att = entry.attachment;
          const reading = entry.state === "reading";
          const failed = entry.state === "error";
          const failureLabel = t("chat.attachments.readFailed", {
            names: att.fileName ?? t("chat.attachments.attachedFile"),
            more: "",
          });
          const removeLabel = att.fileName?.trim()
            ? t("chat.composer.removeNamedAttachment", { name: att.fileName })
            : t("chat.composer.removeAttachment");
          return att.browserAnnotation
            ? renderBrowserAnnotationAttachment(att, att.browserAnnotation, props)
            : isPastedTextAttachment(att)
              ? renderComposerPastedText(att, props)
              : html`
                  <div
                    class=${[
                      "chat-attachment-thumb",
                      att.mimeType.startsWith("image/") ? "" : "chat-attachment-thumb--file",
                      failed ? "chat-attachment-thumb--error" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-busy=${reading ? "true" : "false"}
                  >
                    ${
                      failed
                        ? html`<openclaw-tooltip .content=${failureLabel}>
                            <span
                              class="chat-attachment-error"
                              tabindex="0"
                              role="img"
                              aria-label=${failureLabel}
                            >
                              ${renderAttachmentFileIcon({ filename: att.fileName ?? "", mimeType: att.mimeType, mode: "large-placeholder", unavailable: true })}
                            </span>
                          </openclaw-tooltip>`
                        : reading
                          ? nothing
                          : att.mimeType.startsWith("image/") && getChatAttachmentPreviewUrl(att)
                            ? renderAttachmentImage(
                                att,
                                att.fileName?.trim() || t("chat.composer.attachmentPreview"),
                                att.fileName?.trim() || t("chat.imageLightbox.untitled"),
                                props,
                              )
                            : renderCompactAttachmentFile(att)
                    }
                    <span
                      class="chat-attachment-loading"
                      data-state=${entry.state}
                      data-indeterminate=${reading && entry.progress === undefined ? "true" : "false"}
                      aria-hidden="true"
                      ><span
                        style=${styleMap({ transform: entry.progress === undefined ? undefined : `scaleX(${entry.progress})` })}
                      ></span
                    ></span>
                    <openclaw-tooltip .content=${removeLabel}>
                      <button
                        class="chat-attachment-remove"
                        type="button"
                        aria-label=${removeLabel}
                        ?disabled=${props.disabled}
                        @click=${() => {
                          props.attachmentReads?.remove(entry);
                          removeDraftAttachment(att, props);
                        }}
                      >
                        ${icons.x}
                      </button>
                    </openclaw-tooltip>
                  </div>
                `;
        },
      )}
    </div>
  `;
}
