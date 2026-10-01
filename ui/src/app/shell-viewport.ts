const KEYBOARD_MIN_SHRINK = 80;

function hasKeyboardFocus(): boolean {
  let target = document.activeElement;
  while (target?.shadowRoot?.activeElement) {
    target = target.shadowRoot.activeElement;
  }
  if (target instanceof HTMLTextAreaElement) {
    return !target.readOnly && !target.disabled;
  }
  if (target instanceof HTMLInputElement) {
    return (
      !target.readOnly &&
      !target.disabled &&
      ![
        "button",
        "checkbox",
        "color",
        "file",
        "hidden",
        "image",
        "radio",
        "range",
        "reset",
        "submit",
      ].includes(target.type)
    );
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

/** One viewport owner for the app and fixed/body-portaled shell surfaces. */
export function connectShellViewport(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) {
    return () => {};
  }
  const root = document.documentElement;
  const events = new AbortController();
  let frame: number | null = null;
  let focusHeight: number | null = null;
  let width = root.clientWidth || window.innerWidth;
  const update = () => {
    frame = null;
    const layoutHeight = root.clientHeight || window.innerHeight;
    const nextWidth = root.clientWidth || window.innerWidth;
    const focused = hasKeyboardFocus();
    // Rotation changes the unoccluded reference; a portrait height must not
    // classify the following landscape viewport as a still-open keyboard.
    if (width !== nextWidth || !focused) {
      focusHeight = null;
    }
    width = nextWidth;
    if (focused) {
      focusHeight ??= Math.max(layoutHeight, viewport.height);
    }
    const nativeScale = viewport.scale === 1;
    const keyboard =
      nativeScale &&
      focused &&
      Math.max(layoutHeight, focusHeight ?? 0) - viewport.height >= KEYBOARD_MIN_SHRINK;
    if (keyboard) {
      root.style.setProperty("--shell-safe-area-bottom", "0px");
    } else {
      root.style.removeProperty("--shell-safe-area-bottom");
    }

    // Publish a cap independently of keyboard detection: browser chrome and
    // standalone viewport-unit mismatches can hide less than 80px. CSS keeps
    // the smaller dynamic canvas, so this never promotes it to a larger one.
    if (nativeScale) {
      // A panned caret uses layout coordinates: height alone lifts the footer
      // twice. Insets are consumed by the app's CSS, not subtracted here too.
      root.style.setProperty(
        "--shell-viewport-height",
        String(Math.max(0, viewport.height + viewport.offsetTop)) + "px",
      );
    } else {
      root.style.removeProperty("--shell-viewport-height");
    }
  };
  const schedule = () => {
    frame ??= requestAnimationFrame(update);
  };
  const options = { signal: events.signal };
  viewport.addEventListener("resize", schedule, options);
  viewport.addEventListener("scroll", schedule, options);
  window.addEventListener("resize", schedule, options);
  window.addEventListener("orientationchange", schedule, options);
  document.addEventListener(
    "focusin",
    () => {
      if (hasKeyboardFocus()) {
        focusHeight ??= viewport.height;
      }
      schedule();
    },
    options,
  );
  document.addEventListener("focusout", schedule, options);
  update();
  return () => {
    events.abort();
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
    root.style.removeProperty("--shell-viewport-height");
    root.style.removeProperty("--shell-safe-area-bottom");
  };
}
