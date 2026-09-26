import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../../components/icons.ts";
import { scrollState } from "../../../components/scroll-state.ts";
import "../../../components/tooltip.ts";
import "../../../styles/chat/selection-annotations.css";

type AttachmentChipRemoval = {
  label: string;
  onRemove: (event: Event) => void;
  disabled: boolean;
};

export function renderAttachmentChip(options: {
  label: string;
  icon: TemplateResult;
  onClick?: () => void;
  onReveal?: () => void;
  keyboardClick?: boolean;
  removal?: AttachmentChipRemoval;
  elementRef?: (element: Element | undefined) => void;
}) {
  const label = html`
    <span aria-hidden="true">${options.icon}</span>
    <span
      class=${options.removal ? "chat-selection-annotations__label" : "chat-attachment-preview-label"}
      dir="auto"
      >${options.label}</span
    >
  `;
  return html`<span
    ${options.elementRef ? ref(options.elementRef) : nothing}
    class="chat-attachment-thumb chat-attachment-thumb--file chat-selection-annotations__chip"
    role=${options.removal ? nothing : "button"}
    tabindex=${options.removal ? nothing : "0"}
    @pointerenter=${options.onReveal}
    @focusin=${options.onReveal}
    @click=${options.onClick}
    @keydown=${(event: KeyboardEvent) => {
      if (
        !options.removal &&
        options.keyboardClick !== false &&
        (event.key === "Enter" || event.key === " ") &&
        event.currentTarget instanceof HTMLElement
      ) {
        event.preventDefault();
        event.currentTarget.click();
      }
    }}
  >
    ${
      options.removal
        ? html`<button
            type="button"
            class="chat-attachment-file chat-selection-annotations__trigger"
          >
            ${label}
          </button>`
        : html`<span class="chat-attachment-file">${label}</span>`
    }
    ${
      options.removal
        ? html`<button
            type="button"
            class="chat-selection-annotations__remove"
            aria-label=${options.removal.label}
            ?disabled=${options.removal.disabled}
            @click=${options.removal.onRemove}
          >
            ${icons.x}
          </button>`
        : nothing
    }
  </span>`;
}

export function renderAttachmentPreviewChip(options: {
  label: string;
  regionLabel: string;
  icon: TemplateResult;
  content: TemplateResult;
  onReveal?: () => void;
  openOnClick?: boolean;
  removal?: AttachmentChipRemoval;
  elementRef?: (element: Element | undefined) => void;
}) {
  return html`<openclaw-tooltip
    class=${options.removal ? "chat-comment-preview chat-comment-preview--editable" : "chat-comment-preview"}
    placement="top-start"
    auto-size
    .describe=${false}
    .openOnClick=${options.openOnClick ?? false}
    .hoverDismissDelay=${options.removal ? 200 : undefined}
  >
    ${renderAttachmentChip({
      label: options.label,
      icon: options.icon,
      onReveal: options.onReveal,
      onClick: options.openOnClick ? options.onReveal : undefined,
      keyboardClick: options.openOnClick ?? false,
      removal: options.removal,
      elementRef: options.elementRef,
    })}
    <div
      slot="content"
      class="chat-comment-preview__scroll"
      tabindex="0"
      role="region"
      aria-label=${options.regionLabel}
      ${scrollState()}
    >
      ${options.content}
    </div>
  </openclaw-tooltip>`;
}
