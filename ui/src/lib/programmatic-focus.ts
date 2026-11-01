const TEXT_ENTRY = 'input:not([type="checkbox"], [type="radio"]), textarea, select';
const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "CapsLock", "Control", "Meta", "Shift"]);

let keyboardInput = false;
// The element holding focus without a ring; the next key press shows the ring on it.
let unmarked: HTMLElement | undefined;

/**
 * Moves focus for keyboard and screen reader continuity, painting the ring only after keyboard
 * input. Browsers otherwise decide from how focus last moved, so a pointer-opened surface rang or
 * not depending on what was clicked before it. Text fields keep their native indication.
 */
export function focusProgrammatically(element: HTMLElement, options?: FocusOptions): void {
  if (element.matches(TEXT_ENTRY)) {
    element.focus(options);
    return;
  }
  // Focusing the active element is a no-op, so changing its ring takes a fresh focus.
  if (element.matches(":focus") && element.matches(":focus-visible") !== keyboardInput) {
    element.blur();
  }
  element.focus({ ...options, focusVisible: keyboardInput });
  unmarked = keyboardInput ? undefined : element;
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (MODIFIER_KEYS.has(event.key)) {
        return;
      }
      keyboardInput = true;
      if (unmarked && event.composedPath()[0] === unmarked) {
        focusProgrammatically(unmarked, { preventScroll: true });
      }
    },
    { capture: true, passive: true },
  );
  window.addEventListener("pointerdown", () => (keyboardInput = false), {
    capture: true,
    passive: true,
  });
}
