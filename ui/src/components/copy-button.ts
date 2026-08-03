// Control UI chat module implements copy as markdown behavior.
import { html, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

const COPIED_FOR_MS = 1500;
const ERROR_FOR_MS = 2000;
const feedbackResetTimers = new WeakMap<HTMLButtonElement, number>();

export function copyMarkdownLabel(): string {
  return t("chat.actions.copyAsMarkdown");
}

type CopyButtonOptions = {
  text: () => string;
  label?: string;
  // Chat message footers style their buttons as ghost icons; the .btn chrome
  // (light-mode background overrides) would outrank those rules and box them.
  bare?: boolean;
};

function setButtonLabel(button: HTMLButtonElement, label: string) {
  button.setAttribute("aria-label", label);
}

function createCopyButton(options: CopyButtonOptions): TemplateResult {
  const idleLabel = options.label ?? copyMarkdownLabel();
  return html`
    <openclaw-tooltip .content=${idleLabel}>
      <button
        class=${options.bare ? "chat-copy-btn" : "btn btn--xs chat-copy-btn"}
        type="button"
        aria-label=${idleLabel}
        @click=${async (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement | null;

          if (!btn || btn.dataset.copying === "1") {
            return;
          }

          // Each copy owns its feedback window; old timers must not clear a newer result.
          const previousFeedbackTimer = feedbackResetTimers.get(btn);
          if (previousFeedbackTimer !== undefined) {
            window.clearTimeout(previousFeedbackTimer);
            feedbackResetTimers.delete(btn);
          }
          delete btn.dataset.copied;
          delete btn.dataset.error;
          btn.dataset.copying = "1";
          btn.setAttribute("aria-busy", "true");
          btn.disabled = true;

          const copied = await copyToClipboard(options.text());
          if (!btn.isConnected) {
            return;
          }

          delete btn.dataset.copying;
          btn.removeAttribute("aria-busy");
          btn.disabled = false;

          if (copied) {
            btn.dataset.copied = "1";
          } else {
            btn.dataset.error = "1";
          }
          setButtonLabel(btn, t(copied ? "common.copied" : "common.copyFailed"));

          const feedbackResetTimer = window.setTimeout(
            () => {
              feedbackResetTimers.delete(btn);
              if (!btn.isConnected) {
                return;
              }
              delete btn.dataset.copied;
              delete btn.dataset.error;
              setButtonLabel(btn, idleLabel);
            },
            copied ? COPIED_FOR_MS : ERROR_FOR_MS,
          );
          feedbackResetTimers.set(btn, feedbackResetTimer);
        }}
      >
        <span class="chat-copy-btn__icon" aria-hidden="true">
          <span class="chat-copy-btn__icon-copy">${icons.copy}</span>
          <span class="chat-copy-btn__icon-check">${icons.check}</span>
        </span>
      </button>
    </openclaw-tooltip>
  `;
}

export function renderCopyButton(text: string, label?: string): TemplateResult {
  return createCopyButton({ text: () => text, label });
}

export function renderCopyAsMarkdownButton(markdown: string): TemplateResult {
  return createCopyButton({ text: () => markdown, bare: true });
}
