let keyboardInput = false;

if (typeof window !== "undefined") {
  const track = (type: "keydown" | "pointerdown", keyboard: boolean) =>
    window.addEventListener(type, () => (keyboardInput = keyboard), {
      capture: true,
      passive: true,
    });
  track("keydown", true);
  track("pointerdown", false);
}

/**
 * Moves focus for keyboard and screen reader continuity, painting the ring only after keyboard
 * input. Browsers otherwise decide from how focus last moved, so a pointer-opened surface rang or
 * not depending on what was clicked before it. Text fields keep their native indication.
 */
export function focusProgrammatically(element: HTMLElement, options?: FocusOptions): void {
  if (element.matches('input:not([type="checkbox"], [type="radio"]), textarea, select')) {
    element.focus(options);
  } else {
    element.focus({ ...options, focusVisible: keyboardInput });
  }
}
