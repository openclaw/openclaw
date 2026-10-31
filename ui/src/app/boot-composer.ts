import { listen } from "../lib/reactive/listener.ts";
import { registerControlUiReloadGuard } from "./document-reload-guard.ts";

/**
 * A chat link's static boot frame ships a real composer, so typing starts before
 * any bundle loads, the Gateway admits this browser, or the session route
 * resolves. The document's inline boot script owns its keys until then: Enter
 * only records intent and focus is recorded on the element. This module carries
 * that one element through the app's loading frames until the route's chat pane
 * takes it; the pane's composer submits through its normal admission. An IME
 * composition open across a frame move commits its text; only the candidate
 * window restarts (accepted: rare, visible and recoverable).
 */
export type BootComposerDraft = {
  text: string;
  submit: boolean;
  focused: boolean;
  selection: readonly [start: number, end: number, direction: "forward" | "backward" | "none"];
  scroll: readonly [left: number, top: number];
};

const BOOT_COMPOSER_ID = "openclaw-boot-composer";

let element: HTMLTextAreaElement | null = null;
let scroll: readonly [left: number, top: number] = [0, 0];
let stopHistory: (() => void) | undefined;
let stopReloadGuard: (() => void) | undefined;

/** Takes the static element before the first app commit replaces the boot frame. */
export function adoptBootComposer(applicationRoute: boolean): void {
  const candidate = document.getElementById(BOOT_COMPOSER_ID);
  if (!(candidate instanceof HTMLTextAreaElement)) {
    return;
  }
  if (!applicationRoute || !document.documentElement.hasAttribute("data-openclaw-boot-chat")) {
    candidate.remove();
    return;
  }
  element = candidate;
  scroll = [candidate.scrollLeft, candidate.scrollTop];
  // The pane takes the draft after its loading frame detaches. Keep the last
  // connected viewport; a detached textarea has no scrollable layout box.
  const stopScroll = listen(candidate, "scroll", () => {
    if (candidate.isConnected) {
      scroll = [candidate.scrollLeft, candidate.scrollTop];
    }
  });
  // Until the chat pane takes this element, its text has no durable draft owner.
  const releaseGuard = registerControlUiReloadGuard(
    () => candidate.value.length === 0,
    () => candidate.focus({ preventScroll: true }),
  );
  const stopBeforeUnload = listen(window, "beforeunload", (event) => {
    if (candidate.value.length > 0) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  stopReloadGuard = () => {
    stopScroll();
    releaseGuard();
    stopBeforeUnload();
  };
  // History navigation leaves the linked session; its unsent text must not follow.
  stopHistory = listen(globalThis, "popstate", retireBootComposer);
}

/** The live element for a chat loading frame, or null once taken or retired. */
export function bootComposerElement(): HTMLTextAreaElement | null {
  return element;
}

/** Loading frames call this after inserting the element; a DOM move drops native focus. */
export function settleBootComposer(): void {
  if (
    element?.isConnected &&
    element.hasAttribute("data-focused") &&
    document.activeElement !== element
  ) {
    element.focus({ preventScroll: true });
    [element.scrollLeft, element.scrollTop] = scroll;
  }
}

/** The route's chat pane takes the text, queued Enter and focus exactly once. */
export function takeBootComposer(): BootComposerDraft | null {
  const textarea = element;
  if (!textarea) {
    return null;
  }
  const draft: BootComposerDraft = {
    text: textarea.value,
    submit: textarea.hasAttribute("data-submit-queued"),
    focused: textarea.hasAttribute("data-focused"),
    selection: [textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection],
    scroll: textarea.isConnected ? [textarea.scrollLeft, textarea.scrollTop] : scroll,
  };
  retireBootComposer();
  return draft;
}

/** Leaving the linked session discards the boot composer before any pane can take it. */
export function retireBootComposer(): void {
  stopReloadGuard?.();
  stopReloadGuard = undefined;
  stopHistory?.();
  stopHistory = undefined;
  element?.remove();
  element = null;
  scroll = [0, 0];
}
