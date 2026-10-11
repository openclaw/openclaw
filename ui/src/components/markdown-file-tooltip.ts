import { t } from "../i18n/index.ts";
import { showToast } from "../lib/toast.ts";
import { copyMarkdownText } from "./markdown-copy.ts";
import { createMarkdownIcon } from "./markdown-icon.ts";
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
  const ownerDocument = container.ownerDocument;
  const pathLabel = ownerDocument.createElement("span");
  pathLabel.className = "markdown-file-tooltip__path";
  pathLabel.textContent = path;
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  const icon = createMarkdownIcon("copy", ownerDocument);
  button.append(icon);
  const status = ownerDocument.createElement("span");
  status.setAttribute("role", "status");
  const update = (copied?: boolean) => {
    // The HTTP clipboard fallback focuses a scratch control, dismissing the tooltip.
    if (copied === false && !container.closest("openclaw-tooltip[open]")) {
      showToast({ message: t("common.copyFailed") });
    }
    // Keep the hovered SVG shell, as the former renderer did across icon changes.
    icon.replaceChildren(
      ...createMarkdownIcon(copied ? "check" : "copy", ownerDocument).childNodes,
    );
    status.className = copied === false ? "" : "sr-only";
    status.textContent =
      copied === undefined ? "" : t(copied ? "common.copied" : "common.copyFailed");
  };
  button.addEventListener("click", () => {
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
  });
  container.append(pathLabel, button, status);
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
