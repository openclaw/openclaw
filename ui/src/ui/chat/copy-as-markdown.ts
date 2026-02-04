import { html, type TemplateResult } from "lit";
<<<<<<< HEAD
import { icons } from "../icons";
=======
import { icons } from "../icons.ts";
>>>>>>> upstream/main

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
<<<<<<< HEAD
  if (!text) return false;
=======
  if (!text) {
    return false;
  }
>>>>>>> upstream/main

  try {
    await navigator.clipboard.writeText(text);
    return true;
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
<<<<<<< HEAD
        const iconContainer = btn?.querySelector(".chat-copy-btn__icon") as HTMLElement | null;

        if (!btn || btn.dataset.copying === "1") return;
=======

        if (!btn || btn.dataset.copying === "1") {
          return;
        }
>>>>>>> upstream/main

        btn.dataset.copying = "1";
        btn.setAttribute("aria-busy", "true");
        btn.disabled = true;

        const copied = await copyTextToClipboard(options.text());
<<<<<<< HEAD
        if (!btn.isConnected) return;
=======
        if (!btn.isConnected) {
          return;
        }
>>>>>>> upstream/main

        delete btn.dataset.copying;
        btn.removeAttribute("aria-busy");
        btn.disabled = false;

        if (!copied) {
          btn.dataset.error = "1";
          setButtonLabel(btn, ERROR_LABEL);

          window.setTimeout(() => {
<<<<<<< HEAD
            if (!btn.isConnected) return;
=======
            if (!btn.isConnected) {
              return;
            }
>>>>>>> upstream/main
            delete btn.dataset.error;
            setButtonLabel(btn, idleLabel);
          }, ERROR_FOR_MS);
          return;
        }

        btn.dataset.copied = "1";
        setButtonLabel(btn, COPIED_LABEL);

        window.setTimeout(() => {
<<<<<<< HEAD
          if (!btn.isConnected) return;
=======
          if (!btn.isConnected) {
            return;
          }
>>>>>>> upstream/main
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
