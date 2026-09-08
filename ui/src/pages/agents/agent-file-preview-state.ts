import { t } from "../../i18n/index.ts";

export function previewMetadataRef() {
  let current: Element | undefined;
  let observer: ResizeObserver | undefined;
  return (element: Element | undefined) => {
    current = element;
    observer?.disconnect();
    if (!(element instanceof HTMLElement)) {
      return;
    }
    // Lit commits the ref before its children; a replaced ref must not attach observers.
    queueMicrotask(() => {
      if (current !== element || !element.isConnected) {
        return;
      }
      const chips = [...element.children];
      const fit = () => {
        const compact = window.matchMedia("(max-width: 400px)").matches;
        const style = getComputedStyle(element);
        let remaining =
          element.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight);
        const gap = Number.parseFloat(style.columnGap);
        // Opening scales the dialog's client rects without changing its layout widths.
        const widths = chips.map((chip) => {
          const chipStyle = getComputedStyle(chip);
          return {
            chip,
            width: chipStyle.display === "none" ? 0 : Number.parseFloat(chipStyle.width),
          };
        });
        for (const { chip, width } of widths) {
          const hidden = compact && width > remaining;
          chip.classList.toggle("is-overflowing", hidden);
          if (!hidden && width > 0) {
            remaining -= width + gap;
          }
        }
      };
      fit();
      if (typeof ResizeObserver === "function") {
        observer = new ResizeObserver(fit);
        observer.observe(element);
        for (const chip of chips) {
          observer.observe(chip);
        }
      }
    });
  };
}

export function setPreviewExpandButtonState(
  button: Element | null | undefined,
  isFullscreen: boolean,
) {
  if (!(button instanceof HTMLElement)) {
    return;
  }
  const label = isFullscreen ? t("agents.files.collapsePreview") : t("agents.files.expandPreview");
  button.classList.toggle("is-fullscreen", isFullscreen);
  button.setAttribute("aria-pressed", String(isFullscreen));
  button.setAttribute("aria-label", label);
  button.closest("openclaw-tooltip")?.setAttribute("content", label);
}

export function resetAgentFilePreview(modal: HTMLElement) {
  modal.querySelector(".md-preview-dialog__panel")?.classList.remove("fullscreen");
  setPreviewExpandButtonState(modal.querySelector(".md-preview-expand-btn"), false);
  modal.classList.remove("fullscreen");
}
