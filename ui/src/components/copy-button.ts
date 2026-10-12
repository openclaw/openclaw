// Control UI chat module implements copy as markdown behavior.
import { html, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { copyMarkdownLabel, handleCopyButton } from "./copy-button-state.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";
import "../styles/copy-button.css";

export { copyMarkdownLabel, handleCopyButton } from "./copy-button-state.ts";

export function renderCopyButton(
  text: string,
  idleLabel = copyMarkdownLabel(),
  bare = false,
): TemplateResult {
  // Chat footers own their ghost chrome; .btn backgrounds would box the icon.
  return html`${keyed(
    text,
    html`
      <openclaw-tooltip .content=${idleLabel}>
        <button
          class=${bare ? "chat-copy-btn" : "btn btn--xs chat-copy-btn"}
          type="button"
          aria-label=${idleLabel}
          @click=${(event: Event) => void handleCopyButton(event, text, idleLabel)}
        >
          <span class="chat-copy-btn__icon" aria-hidden="true">
            <span class="chat-copy-btn__icon-copy">${icons.copy}</span>
            <span class="chat-copy-btn__icon-check">${icons.check}</span>
          </span>
        </button>
        <span data-copy-feedback role="status" hidden></span>
      </openclaw-tooltip>
    `,
  )}`;
}

export function renderCopyAsMarkdownButton(markdown: string): TemplateResult {
  return renderCopyButton(markdown, copyMarkdownLabel(), true);
}
