import { html, type TemplateResult } from "lit";
import { renderEmojiIcon, setEmojiIcon } from "../icons";

const COPIED_FOR_MS = 1500;
const ERROR_FOR_MS = 2000;
const COPY_LABEL = "Copy as markdown";
const COPIED_LABEL = "Copied";
const ERROR_LABEL = "Copy failed";
const COPY_ICON = "📋";
const COPIED_ICON = "✓";
const ERROR_ICON = "!";

type CopyButtonOptions = {
  text: () => string;
  label?: string;
};

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

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
        const icon = btn?.querySelector(
          ".chat-copy-btn__icon",
        ) as HTMLElement | null;

        if (!btn || btn.dataset.copying === "1") return;

        btn.dataset.copying = "1";
        btn.setAttribute("aria-busy", "true");
        btn.disabled = true;

        const copied = await copyTextToClipboard(options.text());
        if (!btn.isConnected) return;

        delete btn.dataset.copying;
        btn.removeAttribute("aria-busy");
        btn.disabled = false;

        if (!copied) {
          btn.dataset.error = "1";
          setButtonLabel(btn, ERROR_LABEL);
          setEmojiIcon(icon, ERROR_ICON);

          window.setTimeout(() => {
            if (!btn.isConnected) return;
            delete btn.dataset.error;
            setButtonLabel(btn, idleLabel);
            setEmojiIcon(icon, COPY_ICON);
          }, ERROR_FOR_MS);
          return;
        }

        btn.dataset.copied = "1";
        setButtonLabel(btn, COPIED_LABEL);
        setEmojiIcon(icon, COPIED_ICON);

        window.setTimeout(() => {
          if (!btn.isConnected) return;
          delete btn.dataset.copied;
          setButtonLabel(btn, idleLabel);
          setEmojiIcon(icon, COPY_ICON);
        }, COPIED_FOR_MS);
      }}
    >
      ${renderEmojiIcon(COPY_ICON, "chat-copy-btn__icon")}
    </button>
  `;
}

export function renderCopyAsMarkdownButton(markdown: string): TemplateResult {
  return createCopyButton({ text: () => markdown, label: COPY_LABEL });
}
