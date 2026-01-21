import { html, type TemplateResult } from "lit";

const COPIED_FOR_MS = 1500;
const ERROR_FOR_MS = 2000;
const COPY_LABEL = "Copy as markdown";
const COPIED_LABEL = "Copied";
const ERROR_LABEL = "Copy failed";
const COPY_ICON = "📋";
const COPIED_ICON = "✓";
const ERROR_ICON = "!";

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function renderCopyAsMarkdownButton(markdown: string): TemplateResult {
  return html`
    <button
      class="chat-copy-btn"
      type="button"
      title=${COPY_LABEL}
      aria-label=${COPY_LABEL}
      @click=${async (e: Event) => {
        const btn = e.currentTarget as HTMLButtonElement | null;
        const icon = btn?.querySelector(
          ".chat-copy-btn__icon",
        ) as HTMLElement | null;

        if (!btn || btn.dataset.copying === "1") return;

        btn.dataset.copying = "1";
        btn.setAttribute("aria-busy", "true");
        btn.disabled = true;

        const copied = await copyTextToClipboard(markdown);
        if (!btn.isConnected) return;

        delete btn.dataset.copying;
        btn.removeAttribute("aria-busy");
        btn.disabled = false;

        if (!copied) {
          btn.dataset.error = "1";
          btn.title = ERROR_LABEL;
          btn.setAttribute("aria-label", ERROR_LABEL);
          if (icon) icon.textContent = ERROR_ICON;

          window.setTimeout(() => {
            if (!btn.isConnected) return;
            delete btn.dataset.error;
            btn.title = COPY_LABEL;
            btn.setAttribute("aria-label", COPY_LABEL);
            if (icon) icon.textContent = COPY_ICON;
          }, ERROR_FOR_MS);
          return;
        }

        btn.dataset.copied = "1";
        btn.title = COPIED_LABEL;
        btn.setAttribute("aria-label", COPIED_LABEL);
        if (icon) icon.textContent = COPIED_ICON;

        window.setTimeout(() => {
          if (!btn.isConnected) return;
          delete btn.dataset.copied;
          btn.title = COPY_LABEL;
          btn.setAttribute("aria-label", COPY_LABEL);
          if (icon) icon.textContent = COPY_ICON;
        }, COPIED_FOR_MS);
      }}
    >
      <span class="chat-copy-btn__icon" aria-hidden="true">${COPY_ICON}</span>
    </button>
  `;
}
