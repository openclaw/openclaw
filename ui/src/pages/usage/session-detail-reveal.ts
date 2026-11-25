import { listen } from "../../lib/reactive/listener.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";

const isPhoneWidth = () => globalThis.matchMedia?.("(max-width: 640px)").matches ?? false;
/** Long enough for the report a selection refetches; any touch or scroll ends it sooner. */
const FOLLOW_MS = 4000;

/**
 * Stacked on a phone, the detail panel opens thousands of pixels below the tapped row, where
 * the tap would show nothing. Only a row tap reveals it, and only its X returns to that row.
 */
export function createSessionDetailReveal() {
  let detail: HTMLElement | undefined;
  let row: HTMLElement | undefined;
  let rowButton: HTMLElement | undefined;
  let originKey: string | undefined;
  let pendingKey: string | undefined;
  let returning = false;
  let stopFollowing: (() => void) | undefined;
  // Selecting refetches the report, so the content above collapses and returns after the tap.
  const bringIntoView = (target: HTMLElement, block: ScrollLogicalPosition) => {
    stopFollowing?.();
    const scroll = () => target.scrollIntoView({ block, behavior: resolveScrollBehavior() });
    scroll();
    const page = target.closest(".usage-page");
    if (!page) {
      return;
    }
    const observer = new ResizeObserver(scroll);
    observer.observe(page);
    const inputs = ["wheel", "touchmove", "pointerdown", "keydown"];
    const stop = () => {
      observer.disconnect();
      clearTimeout(timer);
      for (const stopListening of listeners) {
        stopListening();
      }
      stopFollowing = undefined;
    };
    const timer = setTimeout(stop, FOLLOW_MS);
    const listeners = inputs.map((input) =>
      listen(document, input, stop, { capture: true, passive: true }),
    );
    stopFollowing = stop;
  };
  return {
    bindDetail: (element: HTMLElement) => {
      detail = element;
    },
    rowMounted: (key: string, element: HTMLElement, button: HTMLElement) => {
      if (key === originKey) {
        row = element;
        rowButton = button;
      }
    },
    rowSelected: (key: string, element: HTMLElement, button: HTMLElement) => {
      originKey = key;
      row = element;
      rowButton = button;
      pendingKey = isPhoneWidth() ? key : undefined;
    },
    closing: () => {
      returning = isPhoneWidth();
    },
    /** Runs once the rendered panel reflects `key`, or its absence after closing. */
    settle: (key: string | undefined) => {
      if (key) {
        returning = false;
        if (key === pendingKey && detail) {
          pendingKey = undefined;
          bringIntoView(detail, "start");
        }
        return;
      }
      if (returning && row?.isConnected) {
        // Closing removes the focused control, so focus follows the person back to the row.
        rowButton?.focus({ preventScroll: true });
        bringIntoView(row, "center");
      }
      returning = false;
    },
    dispose: () => stopFollowing?.(),
  };
}
