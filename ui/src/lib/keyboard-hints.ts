import { createChangeListeners } from "../../../src/shared/listeners.ts";
import { listen } from "./reactive/listener.ts";

// Phones and tablets without a trackpad report this; desktops and touch laptops do not.
const TOUCH_ONLY_QUERY = "(any-hover: none) and (any-pointer: coarse)";
// On-screen keyboards cannot type these, nor any key outside a text field.
// iPad's on-screen keyboard has Tab, so Tab only counts outside text fields (below).
const HARDWARE_ONLY_KEYS = new Set([
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const changes = createChangeListeners({ snapshot: true });
// Read at import so the first projection read is already right; Node and jsdom lack matchMedia.
const touchOnly = globalThis.matchMedia?.(TOUCH_ONLY_QUERY);
let hardwareKeyboard = false;

/**
 * Owns whether keyboard shortcut hints are worth showing. Browsers expose no
 * keyboard-attached event, so a touch-only device shows hints after its first
 * key press that only a hardware keyboard can produce. Detaching the keyboard
 * keeps hints until reload; that rare, harmless state needs no heuristics.
 */
export const keyboardHints = {
  visible: () => hardwareKeyboard || !touchOnly?.matches,
  subscribe: changes.subscribe,
};

export function isHardwareKeyboardEvent(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229 || event.key === "Unidentified") {
    return false;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || HARDWARE_ONLY_KEYS.has(event.key)) {
    return true;
  }
  const target = event.composedPath()[0];
  return !(
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches("input, textarea, select"))
  );
}

export function installKeyboardHints(view: Window = window): void {
  if (touchOnly) {
    listen(touchOnly, "change", changes.publish);
  }
  const stop = listen(
    view,
    "keydown",
    (event) => {
      if (isHardwareKeyboardEvent(event)) {
        hardwareKeyboard = true;
        stop();
        changes.publish();
      }
    },
    true,
  );
}
