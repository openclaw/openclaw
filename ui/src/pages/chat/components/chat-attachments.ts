// Shared attachment controls for chat and new-session composers.
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { showToast } from "../../../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../../lib/uploads.ts";
import {
  generateAttachmentId,
  registerChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { admitAttachmentFiles, chatAttachmentBatchBytes } from "./chat-attachment-admission.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { currentAttachments } from "./chat-attachment-draft.ts";
import { dataImageClipboardFile } from "./chat-attachment-image.ts";
import { ChatAttachmentReadLifecycle, readChatAttachmentFile } from "./chat-attachment-reads.ts";
import { encodeTextAsDataUrl } from "./chat-attachment-text.ts";

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
  const reads = props.attachmentReads ?? new ChatAttachmentReadLifecycle(() => {});
  const stagedBytes = stagedAttachmentBytes(props);
  const files = admitAttachmentFiles(
    candidates.filter((file) => !unsupported.includes(file)),
    props.attachmentLimits,
    stagedBytes,
    {
      resizeImages: true,
      compressVideos: true,
      onRejected: (file, message) => reads.reject(file, message),
    },
  );
  if (files.length === 0) {
    return 0;
  }
  const entries = reads.begin(
    files,
    currentAttachments(props),
    {
      getAttachments: () => currentAttachments(props),
      onAttachmentsChange: props.onAttachmentsChange,
      onPendingReadsChange: props.onPendingReadsChange,
    },
    props.attachmentLimits,
    stagedBytes,
  );
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
