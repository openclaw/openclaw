// Shared attachment controls for chat and new-session composers.
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { ComposerEditor } from "../../../components/composer-editor.ts";
import { icons } from "../../../components/icons.ts";
import { scrollState } from "../../../components/scroll-state.ts";
import "../../../components/tooltip.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import type { BrowserAnnotationAttachment, ChatAttachment } from "../../../lib/chat/chat-types.ts";
import {
  generateAttachmentId,
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { admitAttachmentFiles } from "./chat-attachment-admission.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { renderAttachmentFileIcon } from "./chat-attachment-file-icon.ts";
import { renderCompactAttachmentFile } from "./chat-attachment-file.ts";
import { ChatAttachmentReadLifecycle, type ChatAttachmentRead } from "./chat-attachment-reads.ts";
import { encodeTextAsDataUrl } from "./chat-attachment-text.ts";
import { renderComposerPastedText } from "./chat-composer-pasted-text.ts";
import { isPastedTextAttachment } from "./chat-pasted-text.ts";
import { renderChatSelectionAnnotations } from "./chat-selection-annotations.ts";

const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,video/*,application/pdf,text/*,.csv,.json,.md,.txt,.zip," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";
const LARGE_PASTE_TEXT_THRESHOLD = 1000;
const LARGE_PASTE_TEXT_MIME_TYPE = "text/plain";
const LARGE_PASTE_TEXT_FILE_PREFIX = "pasted-text-";

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
  const editable = target.closest("textarea, input, openclaw-composer-editor, [contenteditable]");
  if (editable instanceof HTMLInputElement) {
    return TEXT_ENTRY_INPUT_TYPES.has(editable.type) && !editable.disabled && !editable.readOnly;
  }
  if (editable instanceof HTMLTextAreaElement || editable instanceof ComposerEditor) {
    return !editable.disabled && !editable.readOnly;
  }
  return editable instanceof HTMLElement && editable.isContentEditable;
}

function currentAttachments(props: ChatAttachmentControlsProps): ChatAttachment[] {
  return props.getAttachments?.() ?? props.attachments ?? [];
}

function clickComposerInput(target: HTMLElement, selector: string) {
  target.closest("details")?.removeAttribute("open");
  target
    .closest(".agent-chat__composer-shell, .new-session-page__composer")
    ?.querySelector<HTMLInputElement>(selector)
    ?.click();
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

function handleLargeTextPaste(e: ClipboardEvent, props: ChatAttachmentControlsProps): boolean {
  if (!props.onAttachmentsChange) {
    return false;
  }
  const text = e.clipboardData?.getData("text/plain");
  if (!text || text.length <= LARGE_PASTE_TEXT_THRESHOLD) {
    return false;
  }
  e.preventDefault();
  const file = new File([text], `${LARGE_PASTE_TEXT_FILE_PREFIX}${Date.now()}.txt`, {
    type: LARGE_PASTE_TEXT_MIME_TYPE,
  });
  if (admitAttachmentFiles([file], props.attachmentLimits).length === 0) {
    // The rejection toast named the file; the clipboard still holds the text.
    return true;
  }
  const attachment = chatAttachmentFromFile(file, encodeTextAsDataUrl(text), "paste");
  props.onAttachmentsChange([...currentAttachments(props), attachment]);
  return true;
}

function dataImageClipboardFile(
  dataUrl: string,
  baseName = "pasted-image",
): { file: File; dataUrl: string } | null {
  const trimmed = dataUrl.trim();
  const commaIndex = trimmed.indexOf(",");
  const match =
    commaIndex >= 0
      ? /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(trimmed.slice(0, commaIndex))
      : null;
  if (!match) {
    return null;
  }
  const mimeType = match[1]?.toLowerCase();
  const base64Source = trimmed.slice(commaIndex + 1);
  if (!mimeType || !base64Source) {
    return null;
  }
  const base64 = base64Source.replace(/\s+/g, "");
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "png";
    return {
      file: new File([bytes], `${baseName}.${extension}`, { type: mimeType }),
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  } catch {
    return null;
  }
}

/** Builds a registered chat attachment from a base64 image data URL. */
export function chatAttachmentFromDataUrl(
  dataUrl: string,
  fileName: string,
  limits?: ChatAttachmentControlsProps["attachmentLimits"],
): ChatAttachment | null {
  const baseName = fileName.replace(/\.[a-z0-9]+$/i, "") || "image";
  const parsed = dataImageClipboardFile(dataUrl, baseName);
  if (!parsed || admitAttachmentFiles([parsed.file], limits).length === 0) {
    return null;
  }
  return chatAttachmentFromFile(parsed.file, parsed.dataUrl);
}

function readAttachmentFile(
  file: File,
  entry: ChatAttachmentRead,
  reads: ChatAttachmentReadLifecycle,
  props: ChatAttachmentControlsProps,
): void {
  const signal = props.readSignal ?? reads.readSignal;
  if (signal.aborted) {
    reads.remove(entry);
    return;
  }
  const reader = new FileReader();
  let settled = false;
  const finish = (outcome: "ready" | "error" | "aborted") => {
    if (settled) {
      return;
    }
    settled = true;
    signal.removeEventListener("abort", abort);
    entry.cancel = undefined;
    if (outcome === "ready" && typeof reader.result === "string" && !signal.aborted) {
      const completedAttachment = registerChatAttachmentPayload({
        attachment: entry.attachment,
        dataUrl: reader.result,
        file,
      });
      const ready = [...currentAttachments(props), completedAttachment];
      const readyIds = new Set(ready.map(({ id }) => id));
      // Publish only readable payloads, in admission order, before releasing send.
      props.onAttachmentsChange?.(
        reads
          .project(ready)
          .filter(({ attachment }) => readyIds.has(attachment.id))
          .map(({ attachment }) => attachment),
      );
      reads.complete(entry);
    } else if (outcome === "aborted" || signal.aborted) {
      reads.remove(entry);
    } else {
      reads.fail(entry);
    }
    props.onPendingReadsChange?.(-1);
  };
  const abort = () => {
    finish("aborted");
    reader.abort();
  };
  entry.cancel = abort;
  signal.addEventListener("abort", abort, { once: true });
  reader.addEventListener("error", () => finish("error"), { once: true });
  reader.addEventListener("abort", () => finish("aborted"), { once: true });
  reader.addEventListener("load", () => finish("ready"), { once: true });
  reader.addEventListener("progress", (event) => {
    if (!settled && event.lengthComputable && event.total > 0) {
      reads.updateProgress(entry, Math.min(1, Math.max(0, event.loaded / event.total)));
    }
  });
  props.onPendingReadsChange?.(1);
  try {
    reader.readAsDataURL(file);
  } catch {
    finish("error");
  }
}

function appendAttachmentFiles(candidates: readonly File[], props: ChatAttachmentControlsProps) {
  if (!props.onAttachmentsChange || candidates.length === 0 || props.readSignal?.aborted) {
    return;
  }
  const files = admitAttachmentFiles(candidates, props.attachmentLimits);
  if (files.length === 0) {
    return;
  }
  const reads =
    props.attachmentReads ?? new ChatAttachmentReadLifecycle(() => props.onRequestUpdate?.());
  const entries = reads.begin(files, currentAttachments(props));
  entries.forEach((entry, index) => {
    const file = files[index];
    if (file) {
      readAttachmentFile(file, entry, reads, props);
    }
  });
}

export function handleChatAttachmentPaste(e: ClipboardEvent, props: ChatAttachmentControlsProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }
  const imageFiles = Array.from(items)
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (imageFiles.length === 0) {
    const text = e.clipboardData?.getData("text/plain");
    const pasted = text ? dataImageClipboardFile(text) : null;
    if (!pasted) {
      handleLargeTextPaste(e, props);
      return;
    }
    e.preventDefault();
    if (admitAttachmentFiles([pasted.file], props.attachmentLimits).length === 0) {
      return;
    }
    props.onAttachmentsChange([
      ...currentAttachments(props),
      chatAttachmentFromFile(pasted.file, pasted.dataUrl),
    ]);
    return;
  }
  e.preventDefault();
  appendAttachmentFiles(imageFiles, props);
}

function handleChatAttachmentFileSelect(e: Event, props: ChatAttachmentControlsProps) {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const files = [...(input.files ?? [])];
  input.value = "";
  appendAttachmentFiles(files, props);
}

function handleChatAttachmentDrop(e: DragEvent, props: ChatAttachmentControlsProps) {
  e.preventDefault();
  appendAttachmentFiles([...(e.dataTransfer?.files ?? [])], props);
}

type ChatAttachmentDropProps = ChatAttachmentControlsProps & {
  canCompose: boolean;
};

// Both composers share balanced nested drag state and cancel non-editable
// text/URL drops so disabled surfaces cannot navigate away from a draft.
export function createChatAttachmentDropHandlers(props: ChatAttachmentDropProps) {
  let depth = 0;
  const setActive = (event: DragEvent, active: boolean) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (active) {
      if (!props.canCompose || !isFileDrag(event.dataTransfer)) {
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
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = props.canCompose ? "copy" : "none";
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
      clearActive(event);
      if (props.canCompose) {
        handleChatAttachmentDrop(event, props);
      }
    },
  };
}

export function renderChatAttachmentInputs(props: ChatAttachmentControlsProps) {
  return html`
    ${(["file", "photo", "camera"] as const).map(
      (kind) => html`
        <input
          type="file"
          accept=${kind === "file" ? CHAT_ATTACHMENT_ACCEPT : "image/*"}
          ?multiple=${kind !== "camera"}
          capture=${kind === "camera" ? "environment" : nothing}
          class=${`agent-chat__${kind}-input`}
          ?disabled=${props.disabled}
          @change=${(event: Event) => {
            if (!props.disabled) {
              handleChatAttachmentFileSelect(event, props);
            }
          }}
        />
      `,
    )}
  `;
}

export function handleChatAttachmentMenuSelection(
  event: CustomEvent<{ item: { value?: string } }>,
): boolean {
  const value = event.detail.item.value;
  if (value !== "camera" && value !== "photo" && value !== "file") {
    return false;
  }
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    clickComposerInput(target, `.agent-chat__${value}-input`);
  }
  return true;
}

export function renderChatAttachmentMenuTrigger(
  disabled: boolean | undefined,
  hasOverrides = false,
) {
  return html`
    <button
      slot="trigger"
      type="button"
      class="agent-chat__input-btn agent-chat__input-btn--attach ${
        hasOverrides ? "agent-chat__input-btn--has-overrides" : ""
      }"
      aria-label=${t("chat.composer.addAttachment")}
      ?disabled=${disabled}
      title=${t("chat.composer.addAttachment")}
    >
      ${icons.plus}
    </button>
  `;
}

export function renderChatAttachmentMenuOptions(fileIcon = icons.folder) {
  return html`
    <wa-dropdown-item class="agent-chat__attach-menu-option" value="camera">
      <span slot="icon" aria-hidden="true">${icons.camera}</span>
      <span>${t("chat.composer.takePhoto")}</span>
    </wa-dropdown-item>
    <wa-dropdown-item class="agent-chat__attach-menu-option" value="photo">
      <span slot="icon" aria-hidden="true">${icons.image}</span>
      <span>${t("chat.composer.attachPhoto")}</span>
    </wa-dropdown-item>
    <wa-dropdown-item class="agent-chat__attach-menu-option" value="file">
      <span slot="icon" aria-hidden="true">${fileIcon}</span>
      <span>${t("chat.composer.attachFileOption")}</span>
    </wa-dropdown-item>
  `;
}

function removeBrowserAnnotationAttachment(
  attachment: ChatAttachment,
  props: ChatAttachmentControlsProps,
): void {
  if (props.onRemoveAttachment) {
    props.onRemoveAttachment(attachment);
    return;
  }
  const next = currentAttachments(props).filter((candidate) => candidate.id !== attachment.id);
  releaseChatAttachmentPayload(attachment.id);
  props.onAttachmentsChange?.(next);
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
          @click=${() => removeBrowserAnnotationAttachment(attachment, props)}
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
                          const next = currentAttachments(props).filter((a) => a.id !== att.id);
                          releaseChatAttachmentPayload(att.id);
                          props.onAttachmentsChange?.(next);
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
