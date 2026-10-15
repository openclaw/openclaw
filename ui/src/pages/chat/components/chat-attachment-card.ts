import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import {
  resolveAttachmentFileIcon,
  type AttachmentFileVisualMode,
} from "./chat-attachment-file-icon.ts";
import type { AttachmentItem } from "./chat-message-media.ts";

registerChatMessageMetadataEnglish();

export type AttachmentCardHeaderOptions = {
  kind: AttachmentItem["attachment"]["kind"];
  label: string;
  mimeType?: string;
  sizeBytes?: number;
  downloadHref?: string;
  downloadPending?: boolean;
  downloadPendingFocusable?: boolean;
  onDownload?: () => void;
  loading?: boolean;
  expandLabel?: string;
  onExpand?: () => void;
  visualMode?: AttachmentFileVisualMode;
  voiceNote?: boolean;
};

const attachmentCardInteractiveSelector =
  "a, button, input, select, textarea, audio, video, iframe, [contenteditable='true'], [tabindex], [role='button']";

export function openAttachmentCardFromClick(
  event: MouseEvent,
  onOpen: (() => void) | undefined,
): void {
  if (!onOpen || event.defaultPrevented) {
    return;
  }
  // A control can replace its SVG during this event (for example mute/unmute).
  // The dispatch path retains the original button even after its icon detaches.
  for (const target of event.composedPath()) {
    if (target === event.currentTarget) {
      break;
    }
    if (target instanceof Element && target.matches(attachmentCardInteractiveSelector)) {
      return;
    }
  }
  onOpen();
}

const attachmentTypeLabels = new Map([
  ["audio", "chat.attachments.audio"],
  ["video", "chat.attachments.video"],
  ["image", "chat.attachments.attachedFile"],
]);

export function prepareAttachmentCardHeader(options: AttachmentCardHeaderOptions, translate = t) {
  const formattedSize =
    options.sizeBytes === undefined ? undefined : formatBytes(options.sizeBytes);
  const typeLabelKey = attachmentTypeLabels.get(options.kind);
  const typeLabel = typeLabelKey
    ? translate(typeLabelKey)
    : resolveAttachmentFileIcon(options.label, options.mimeType).extensionLabel;
  const downloadLabel = options.kind === "document" ? translate("chat.attachments.download") : "";
  return {
    compactPreview: options.visualMode === "preview-with-favicon",
    formattedSize,
    metadata: [typeLabel, formattedSize].filter(Boolean).join(" · "),
    downloadLabel,
    downloadClass: `chat-assistant-attachment-card__action chat-assistant-attachment-card__download chat-assistant-attachment-card__download--ghost ${
      downloadLabel
        ? "chat-assistant-attachment-card__action--labeled"
        : options.onExpand !== undefined
          ? "chat-assistant-attachment-card__download--secondary"
          : ""
    } ${options.loading ? "skeleton" : ""}`,
    downloadTitle: translate("chat.mediaPlayer.download", { filename: options.label }),
    expandLabel:
      options.expandLabel ?? translate("chat.attachments.expand", { filename: options.label }),
  };
}
