import { html, type TemplateResult } from "lit";
import { icons } from "../icons.ts";

const COPIED_FOR_MS = 1500;
const ERROR_FOR_MS = 2000;
const COPY_LABEL = "Copy as markdown";
const COPIED_LABEL = "Copied";
const ERROR_LABEL = "Copy failed";

type CopyButtonOptions = {
  text: () => string;
  label?: string;
};

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  // Prefer the async Clipboard API (requires secure context: HTTPS or localhost).
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy fallback.
    }
  }

  // Legacy fallback for non-secure contexts (e.g. HTTP, Tailscale serve, iframes).
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Avoid scrolling to bottom on iOS.
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function setButtonLabel(button: HTMLButtonElement, label: string) {
  button.title = label;
  button.setAttribute("aria-label", label);
}

function createCopyButton(options: CopyButtonOptions): TemplateResult {
  const idleLabel = options.label ?? COPY_LABEL;
  return html`
    <button
      class="chat-copy-btn"
      type="button"
      title=${idleLabel}
      aria-label=${idleLabel}
      @click=${async (e: Event) => {
        const btn = e.currentTarget as HTMLButtonElement | null;

        if (!btn || btn.dataset.copying === "1") {
          return;
        }

        btn.dataset.copying = "1";
        btn.setAttribute("aria-busy", "true");
        btn.disabled = true;

        const copied = await copyTextToClipboard(options.text());
        if (!btn.isConnected) {
          return;
        }

        delete btn.dataset.copying;
        btn.removeAttribute("aria-busy");
        btn.disabled = false;

        if (!copied) {
          btn.dataset.error = "1";
          setButtonLabel(btn, ERROR_LABEL);

          window.setTimeout(() => {
            if (!btn.isConnected) {
              return;
            }
            delete btn.dataset.error;
            setButtonLabel(btn, idleLabel);
          }, ERROR_FOR_MS);
          return;
        }

        btn.dataset.copied = "1";
        setButtonLabel(btn, COPIED_LABEL);

        window.setTimeout(() => {
          if (!btn.isConnected) {
            return;
          }
          delete btn.dataset.copied;
          setButtonLabel(btn, idleLabel);
        }, COPIED_FOR_MS);
      }}
    >
      <span class="chat-copy-btn__icon" aria-hidden="true">
        <span class="chat-copy-btn__icon-copy">${icons.copy}</span>
        <span class="chat-copy-btn__icon-check">${icons.check}</span>
      </span>
    </button>
  `;
}

export function renderCopyAsMarkdownButton(markdown: string): TemplateResult {
  return createCopyButton({ text: () => markdown, label: COPY_LABEL });
}
