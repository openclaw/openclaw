import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";

const COPIED_FOR_MS = 1500;
const ERROR_FOR_MS = 2000;
export function copyMarkdownLabel(): string {
  return t("chat.actions.copyAsMarkdown");
}

function readButtonLabel(button: HTMLButtonElement) {
  return (
    button.querySelector("[data-copy-label]")?.textContent ?? button.getAttribute("aria-label")
  );
}

function setButtonLabel(button: HTMLButtonElement, label: string, showFeedback = false) {
  // Feedback sits beside fixed-size icons; actionable tooltips dismiss on click.
  const feedback = button.parentElement?.querySelector<HTMLElement>("[data-copy-feedback]");
  if (feedback) {
    feedback.hidden = !showFeedback;
    feedback.textContent = label;
  }
  // Preserve renderer-owned text markers while updating visible feedback.
  const visibleLabel = button.querySelector("[data-copy-label]")?.lastChild;
  if (visibleLabel?.nodeType === Node.TEXT_NODE) {
    visibleLabel.nodeValue = label;
  } else {
    button.setAttribute("aria-label", label);
  }
}

export async function handleCopyButton(event: Event, text: string, idleLabel: string) {
  // SAFETY: Callers bind this handler directly to native button click events.
  const button = event.currentTarget as HTMLButtonElement | null;
  if (!button || button.dataset.copyState === "copying") {
    return false;
  }

  // Older reset timers must not replace feedback from a newer copy attempt.
  const attempt = String(Number(button.dataset.copyAttempt ?? "0") + 1);
  button.dataset.copyAttempt = attempt;
  button.dataset.copyState = "copying";
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  setButtonLabel(button, idleLabel);

  // Callers key mutable controls by payload, retiring their fallback and feedback
  // when the text changes. Already-submitted native writes cannot be cancelled.
  const isCurrent = () => button.isConnected && button.dataset.copyAttempt === attempt;
  const copied = await copyToClipboard(text, isCurrent);
  delete button.dataset.copyState;
  button.removeAttribute("aria-busy");
  button.disabled = false;
  if (!isCurrent()) {
    return false;
  }

  button.dataset.copyState = copied ? "copied" : "error";
  // Keep a locale rerender that landed while the clipboard write was pending.
  const resetLabel = readButtonLabel(button) ?? idleLabel;
  const feedbackLabel = t(copied ? "common.copied" : "common.copyFailed");
  setButtonLabel(button, feedbackLabel, true);

  const duration = copied ? COPIED_FOR_MS : ERROR_FOR_MS;
  window.setTimeout(() => {
    if (!isCurrent()) {
      return;
    }
    delete button.dataset.copyState;
    // A locale rerender can replace the idle label while feedback is still active.
    const renderedLabel = readButtonLabel(button);
    setButtonLabel(
      button,
      renderedLabel && renderedLabel !== feedbackLabel ? renderedLabel : resetLabel,
    );
  }, duration);
  return copied;
}
