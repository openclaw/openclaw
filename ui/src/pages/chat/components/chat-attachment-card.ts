import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import {
  renderAttachmentFileIcon,
  resolveAttachmentFileIcon,
  type AttachmentFileVisualMode,
} from "./chat-attachment-file-icon.ts";
import type { AttachmentItem } from "./chat-message-media.ts";

type AttachmentCardKind = Extract<
  AttachmentItem["attachment"]["kind"],
  "audio" | "document" | "image" | "video"
>;

export type AttachmentCardHeaderOptions = {
  kind: AttachmentCardKind;
  label: string;
  mimeType?: string;
  sizeBytes?: number;
  downloadHref?: string;
  downloadPending?: boolean;
  loading?: boolean;
  expandLabel?: string;
  onExpand?: () => void;
  visualMode?: AttachmentFileVisualMode;
  voiceNote?: boolean;
};

export function renderCompactAttachmentCard(options: AttachmentCardHeaderOptions): TemplateResult {
  return html`<div
    class="chat-assistant-attachment-card chat-assistant-attachment-card--compact"
    ?data-openable=${Boolean(options.onExpand)}
    @click=${(event: MouseEvent) => openAttachmentCardFromClick(event, options.onExpand)}
  >
    ${renderAttachmentCardHeader({ ...options, visualMode: "large-placeholder" })}
  </div>`;
}

export function renderAttachmentPreviewSkeleton() {
  return html`<div
    class="sidebar-attachment-preview__loading"
    role="status"
    aria-label=${t("common.loading")}
  >
    <div class="skeleton skeleton-line" aria-hidden="true"></div>
    <div class="skeleton skeleton-line skeleton-line--long" aria-hidden="true"></div>
    <div class="skeleton skeleton-line skeleton-line--medium" aria-hidden="true"></div>
  </div>`;
}

const attachmentCardInteractiveSelector =
  "a, button, input, select, textarea, audio, video, iframe, [contenteditable='true'], [tabindex], [role='button']";

export function openAttachmentCardFromClick(
  event: MouseEvent,
  onOpen: (() => void) | undefined,
): void {
  if (!onOpen || event.defaultPrevented) {
    return;
  }
  const target = event.target;
  const card = event.currentTarget;
  if (target instanceof Element && card instanceof Element) {
    const interactive = target.closest(attachmentCardInteractiveSelector);
    if (interactive && card.contains(interactive)) {
      return;
    }
  }
  onOpen();
}

function attachmentTypeLabel(
  kind: AttachmentCardKind,
  label: string,
  mimeType: string | undefined,
): string {
  if (kind === "audio") {
    return t("chat.attachments.audio");
  }
  if (kind === "video") {
    return t("chat.attachments.video");
  }
  if (kind === "image") {
    return t("chat.attachments.attachedFile");
  }
  return resolveAttachmentFileIcon(label, mimeType).extensionLabel;
}

export function renderAttachmentCardIcon(options: {
  label: string;
  mimeType?: string;
  visualMode?: AttachmentFileVisualMode;
  unavailable?: boolean;
  loading?: boolean;
}) {
  return renderAttachmentFileIcon({
    filename: options.label,
    mimeType: options.mimeType,
    mode: options.visualMode ?? "large-placeholder",
    unavailable: options.unavailable,
    loading: options.loading,
  });
}

export function renderAttachmentCardHeader(options: AttachmentCardHeaderOptions): TemplateResult {
  const skeleton = options.loading ? "skeleton" : "";
  const compactPreview = options.visualMode === "preview-with-favicon";
  const formattedSize =
    options.sizeBytes === undefined ? undefined : formatBytes(options.sizeBytes);
  const typeLabel = attachmentTypeLabel(options.kind, options.label, options.mimeType);
  const metadata = [typeLabel, formattedSize].filter(Boolean).join(" · ");
  const downloadTitle = t("chat.mediaPlayer.download", { filename: options.label });
  const hasOpenAction = options.onExpand !== undefined;
  const expandLabel =
    options.expandLabel ?? t("chat.attachments.expand", { filename: options.label });
  const downloadClass = `chat-assistant-attachment-card__action chat-assistant-attachment-card__download chat-assistant-attachment-card__download--ghost ${
    hasOpenAction ? "chat-assistant-attachment-card__download--secondary" : ""
  }`;
  return html`
    <div
      class="chat-assistant-attachment-card__header ${
        compactPreview ? "chat-assistant-attachment-card__header--preview" : ""
      }"
    >
      <div class="chat-assistant-attachment-card__identity">
        ${renderAttachmentCardIcon({
          label: options.label,
          mimeType: options.mimeType,
          visualMode: options.visualMode,
          loading: options.loading,
        })}
        <span
          class="chat-assistant-attachment-card__details ${
            compactPreview ? "chat-assistant-attachment-card__details--preview" : ""
          }"
        >
          <span class="chat-assistant-attachment-card__title ${skeleton}" title=${options.label}
            >${options.label}</span
          >
          ${
            compactPreview
              ? formattedSize
                ? html`<span class="chat-assistant-attachment-card__separator" aria-hidden="true"
                      >·</span
                    ><span class="chat-assistant-attachment-card__meta ${skeleton}"
                      >${formattedSize}</span
                    >`
                : null
              : html`<span class="chat-assistant-attachment-card__meta">${metadata}</span>`
          }
        </span>
      </div>
      <span class="chat-assistant-attachment-card__actions">
        ${
          options.voiceNote && !compactPreview
            ? html`<span class="chat-assistant-attachment-badge"
                >${t("chat.messages.voiceNote")}</span
              >`
            : null
        }
        ${
          options.downloadHref || options.downloadPending
            ? html`<a
                class=${`${downloadClass} ${skeleton}`}
                href=${options.downloadPending ? nothing : options.downloadHref}
                aria-disabled=${options.downloadPending ? "true" : nothing}
                role="link"
                download=${options.label}
                target="_blank"
                rel="noreferrer"
                aria-label=${downloadTitle}
                title=${downloadTitle}
                >${icons.download}</a
              >`
            : null
        }
        ${
          hasOpenAction
            ? html`<button
                type="button"
                class="chat-assistant-attachment-card__action ${
                  compactPreview
                    ? "chat-assistant-attachment-card__expand--icon"
                    : "chat-assistant-attachment-card__action--labeled"
                } chat-assistant-attachment-card__expand"
                aria-label=${expandLabel}
                title=${expandLabel}
                @click=${options.onExpand}
              >
                ${
                  compactPreview
                    ? icons.chevronsUpDown
                    : html`<span>${t("chat.attachments.open")}</span>`
                }
              </button>`
            : null
        }
      </span>
    </div>
  `;
}
