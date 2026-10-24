import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";

const COPIED_FOR_MS = 1500;
const ERROR_FOR_MS = 2000;
export function copyMarkdownLabel(): string {
  return t("chat.actions.copyAsMarkdown");
}

type CopyButtonTargets = {
  label?: HTMLElement;
  feedback?: HTMLElement;
  announcement?: HTMLElement;
};

function readButtonLabel(button: HTMLButtonElement, targets: CopyButtonTargets) {
  return targets.label?.textContent ?? button.getAttribute("aria-label");
}

function setButtonLabel(
  button: HTMLButtonElement,
  targets: CopyButtonTargets,
  label: string,
  showFeedback = false,
) {
  // Feedback sits beside fixed-size icons; actionable tooltips dismiss on click.
  const feedback = targets.feedback;
  if (feedback) {
    feedback.hidden = !showFeedback;
    feedback.textContent = label;
  }
  // Keep the live region present while clearing idle and pending announcements.
  if (targets.announcement) {
    targets.announcement.textContent = showFeedback ? label : "";
  }
  // Preserve renderer-owned text markers while updating visible feedback.
  const visibleLabel = targets.label?.lastChild;
  if (visibleLabel?.nodeType === Node.TEXT_NODE) {
    visibleLabel.nodeValue = label;
  } else {
    button.setAttribute("aria-label", label);
  }
}

export async function handleCopyButton(
  event: Event,
  text: string,
  idleLabel: string,
  targets: CopyButtonTargets = {},
) {
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
  setButtonLabel(button, targets, idleLabel);

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
  const resetLabel = readButtonLabel(button, targets) ?? idleLabel;
  const feedbackLabel = t(copied ? "common.copied" : "common.copyFailed");
  setButtonLabel(button, targets, feedbackLabel, true);

  const duration = copied ? COPIED_FOR_MS : ERROR_FOR_MS;
  window.setTimeout(() => {
    if (!isCurrent()) {
      return;
    }
    delete button.dataset.copyState;
    // A locale rerender can replace the idle label while feedback is still active.
    const renderedLabel = readButtonLabel(button, targets);
    setButtonLabel(
      button,
      targets,
      renderedLabel && renderedLabel !== feedbackLabel ? renderedLabel : resetLabel,
    );
  }, duration);
  return copied;
}
