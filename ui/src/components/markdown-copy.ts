import { copyToClipboard } from "../lib/clipboard.ts";

const copyAttempts = new WeakMap<HTMLElement, number>();
const resetTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Retained controls may change payload while a clipboard write is pending. */
export function copyMarkdownText(
  button: HTMLElement,
  text: string,
  ownsPayload: () => boolean,
  feedback: (copied: boolean | undefined) => void,
  // A dismissed control can revoke a second transport while retaining settled feedback.
  canFallback: () => boolean = () => true,
): void {
  const attempt = (copyAttempts.get(button) ?? 0) + 1;
  copyAttempts.set(button, attempt);
  const isCurrent = () =>
    button.isConnected && copyAttempts.get(button) === attempt && ownsPayload();
  void copyToClipboard(text, () => isCurrent() && canFallback()).then((copied) => {
    if (!isCurrent()) {
      return;
    }
    feedback(copied);
    clearTimeout(resetTimers.get(button));
    resetTimers.set(
      button,
      setTimeout(
        () => {
          feedback(undefined);
          resetTimers.delete(button);
        },
        copied ? 1500 : 2000,
      ),
    );
  });
}
