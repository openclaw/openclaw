import { t } from "../../i18n/index.ts";

export function countWords(text: string) {
  const normalized = text.trim();
  return normalized ? normalized.split(/\s+/).length : 0;
}

export function countLines(text: string) {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

export function estimateReadingTimeLabel(wordCount: number) {
  if (wordCount <= 0) {
    return t("agents.files.emptyDraft");
  }
  return t("agents.files.minRead", { count: String(Math.max(1, Math.round(wordCount / 220))) });
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
