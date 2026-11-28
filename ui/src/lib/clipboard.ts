import { registryFor } from "../components/overlay-registry.ts";
import { resolveTransientContainer } from "../components/transient-container.ts";

// The async Clipboard API is only exposed in secure contexts (HTTPS or
// localhost). On plain-HTTP deployments (e.g. LAN access) `navigator.clipboard`
// is undefined, so calling it throws synchronously rather than rejecting. Guard
// the secure-context path and fall back to the legacy execCommand copy so the
// copy buttons keep working over HTTP. Returns whether the copy succeeded.
let clipboardWriteAttempt = 0;

export function beginClipboardCopy(): number {
  return ++clipboardWriteAttempt;
}

/**
 * Copies text, or text still being fetched. A promise is handed to the browser while the user
 * gesture is live, so Safari and Chrome accept the write after an async read; reject it to
 * abort the copy without touching the clipboard.
 */
export async function copyToClipboard(
  pending: string | Promise<string>,
  shouldFallback?: () => boolean,
): Promise<boolean> {
  const attempt = beginClipboardCopy();
  // The clipboard is shared across controls. A newer copy or a retired caller cancels a
  // delayed transport before it can overwrite the user's selection.
  const retired = () => attempt !== clipboardWriteAttempt || shouldFallback?.() === false;
  if (pending === "") {
    return false;
  }
  // Copy controls can lose focus when disabled while the async transport settles.
  const overlay =
    typeof document === "undefined"
      ? undefined
      : registryFor(document).stack.findLast(
          (entry) => entry.open && entry.contains(document.activeElement),
        );
  if (
    typeof pending !== "string" &&
    navigator.clipboard?.write &&
    typeof ClipboardItem === "function"
  ) {
    try {
      const blob = pending.then((value) => new Blob([value], { type: "text/plain" }));
      void blob.catch(() => undefined);
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    } catch {
      // Rejected text, denied permission, or no ClipboardItem promise support: retry below.
    }
  }
  const text = typeof pending === "string" ? pending : await pending.catch(() => "");
  if (!text || (typeof pending !== "string" && retired())) {
    return false;
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Secure-context API present but rejected (e.g. denied permission);
      // fall through to the execCommand path before giving up.
    }
  }
  if (retired()) {
    return false;
  }
  return copyWithExecCommand(
    text,
    overlay?.open && overlay.surface.isConnected ? overlay.surface : undefined,
  );
}

function copyWithExecCommand(text: string, overlaySurface?: HTMLElement): boolean {
  const textarea = document.createElement("textarea");
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  textarea.value = text;
  // Keep the scratch node off-screen so the selection does not scroll or flash.
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  // Keep temporary selection inside the initiating overlay so it does not dismiss.
  // Outside an active modal the document is inert, so its selection cannot be copied.
  const layers = [...(document.openClawModalLayers ?? [])].filter((modal) => modal.isConnected);
  const container = overlaySurface ?? resolveTransientContainer(layers.toReversed(), document);
  if (!container) {
    return false;
  }
  container.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (previouslyFocused?.isConnected) {
      // Deferred focus must retain its document after that environment's globals retire.
      const ownerDocument = textarea.ownerDocument;
      window.setTimeout(() => {
        const { activeElement, body } = ownerDocument;
        if (previouslyFocused.isConnected && (!activeElement || activeElement === body)) {
          previouslyFocused.focus({ preventScroll: true });
        }
      }, 0);
    }
  }
}
