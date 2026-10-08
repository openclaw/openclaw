import { html, render } from "lit";
import { t } from "../i18n/index.ts";
import { showToast } from "../lib/toast.ts";
import { icons } from "./icons.ts";
import { copyMarkdownText } from "./markdown-copy.ts";
import "../styles/markdown-file-tooltip.css";

/** The shared tooltip owns visibility, input modality, positioning, and dismissal. */
export function renderMarkdownFileTooltip(container: HTMLElement, path: string) {
  container.replaceChildren();
  const label = t("chat.workspaceFiles.copyPath");
  const tooltip = container.closest("openclaw-tooltip");
  if (!tooltip) {
    throw new Error("File path content requires a tooltip owner");
  }
  let generation = 0;
  let fallbackInProgress = false;
  const update = (copied?: boolean) => {
    // The HTTP clipboard fallback focuses a scratch control, dismissing the tooltip.
    if (copied === false && !container.closest("openclaw-tooltip[open]")) {
      showToast({ message: t("common.copyFailed") });
    }
    render(
      html`
        <span class="markdown-file-tooltip__path">${path}</span>
        <button
          type="button"
          aria-label=${label}
          @click=${(event: Event) => {
            const button = event.currentTarget;
            if (button instanceof HTMLButtonElement) {
              const currentGeneration = generation;
              let fallbackStarted = false;
              copyMarkdownText(
                button,
                path,
                () =>
                  container.isConnected &&
                  currentGeneration === generation &&
                  tooltip.anchor?.getAttribute("data-file-path") === path,
                (result) => {
                  fallbackInProgress = false;
                  const anchor = tooltip.anchor;
                  if (
                    result !== undefined &&
                    fallbackStarted &&
                    anchor instanceof HTMLElement &&
                    tooltip.ownerDocument.activeElement === tooltip.ownerDocument.body
                  ) {
                    // The closed tooltip makes its copy button inert; return to the live link.
                    tooltip.focusTriggerWithoutOpening(anchor);
                  }
                  if (result === undefined || fallbackStarted || tooltip.hasAttribute("open")) {
                    update(result);
                  }
                },
                () => {
                  fallbackStarted = tooltip.hasAttribute("open");
                  fallbackInProgress = fallbackStarted;
                  return fallbackStarted;
                },
              );
            }
          }}
        >
          ${copied ? icons.check : icons.copy}
        </button>
        <span class=${copied === false ? "" : "sr-only"} role="status">
          ${copied === undefined ? "" : t(copied ? "common.copied" : "common.copyFailed")}
        </span>
      `,
      container,
    );
  };
  update();
  const observer = new MutationObserver((records) => {
    // A close permanently retires pending copies, even if the same link reopens.
    const closed = records.some((record, index) => {
      const next = records[index + 1];
      const value = next ? next.oldValue : tooltip.getAttribute("open");
      return record.oldValue !== null && value === null;
    });
    if (closed && !fallbackInProgress) {
      generation++;
      update();
    }
  });
  observer.observe(tooltip, {
    attributes: true,
    attributeFilter: ["open"],
    attributeOldValue: true,
  });
  return () => observer.disconnect();
}
