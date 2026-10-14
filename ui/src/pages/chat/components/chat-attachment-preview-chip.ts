import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../../components/icons.ts";
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
