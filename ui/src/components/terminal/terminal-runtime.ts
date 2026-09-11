import type { CreateGhosttyTerminalOptions } from "@openclaw/libterminal/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

function isEventListener(value: unknown): value is EventListener {
  return typeof value === "function";
}

// Module-level WeakMap: probe result per container element, cached so each
// container is interrogated at most once even across multiple install calls.
const imeWorkaroundBugCache = new WeakMap<Element, boolean>();

/**
 * Installs an IME forwarding shim on the ghostty container for Android
 * soft-keyboard input.
 *
 * ghostty-web 0.4.0 registers `addEventListener("beforeinput", e => e.preventDefault())`
 * on its container and skips keyCode 229 events in its keydown handler, so
 * committed IME text from Android soft keyboards never reaches the PTY write
 * path (coder/ghostty-web#120, open, unreleased). This shim intercepts
 * `beforeinput` in capture phase, ahead of ghostty's bubble-phase handler,
 * and forwards data by dispatching a `compositionend` on the ghostty container,
 * which ghostty's own listener picks up and passes to `onDataCallback(data)`.
 *
 * Scoped to coarse-pointer touch devices only so desktop CJK input, which
 * has a working native `compositionend`, is not doubled.
 *
 * Remove this workaround when coder/ghostty-web#120 is fixed and the minimum
 * bundled ghostty-web version includes the fix.
 *
 * @param parent - The ghostty container element (`options.parent` from
 *   `createIsolatedGhosttyTerminal`).
 * @returns A cleanup function that removes all installed listeners.
 */
export function installTerminalImeWorkaround(parent: Element): () => void {
  // Guard: coarse-pointer touch devices only. Desktop CJK composition already
  // works via native compositionend; applying this shim there would double input.
  if (
    !(navigator.maxTouchPoints > 0) ||
    !(typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches)
  ) {
    return () => {};
  }

  // Probe whether ghostty's beforeinput-clobber bug is still present. The probe
  // is run once at install time, before any of our listeners are registered, to
  // avoid the probe event re-entering our own handlers. The result is cached in
  // the module-level WeakMap so repeated calls for the same container are
  // pure cache lookups (no per-keystroke probe dispatches).
  if (!imeWorkaroundBugCache.has(parent)) {
    const probe = new InputEvent("beforeinput", {
      bubbles: false,
      cancelable: true,
      inputType: "insertText",
      data: "",
    });
    parent.dispatchEvent(probe);
    imeWorkaroundBugCache.set(parent, probe.defaultPrevented);
  }
  if (!imeWorkaroundBugCache.get(parent)) {
    // ghostty-web fixed its beforeinput handling; no workaround needed.
    return () => {};
  }

  let imeActive = false;

  function onKeyDown(event: Event): void {
    const ke = event as KeyboardEvent;
    if (ke.keyCode === 229 || ke.isComposing) {
      imeActive = true;
    }
  }

  function onCompositionStart(): void {
    imeActive = true;
  }

  function onCompositionEnd(): void {
    // Reset our tracking state. Ghostty's own compositionend listener also
    // runs for the synthetic event we dispatch in onBeforeInput.
    imeActive = false;
  }

  /**
   * Walk composedPath() to find the ghostty container: the element that owns
   * both a canvas child (the renderer) and a textarea child (the IME proxy).
   */
  function findGhosttyContainer(path: EventTarget[]): Element | null {
    for (const target of path) {
      if (!(target instanceof Element)) {
        continue;
      }
      if (target.querySelector("canvas") !== null && target.querySelector("textarea") !== null) {
        return target;
      }
    }
    return null;
  }

  function onBeforeInput(event: Event): void {
    if (!imeActive) {
      return;
    }
    const ie = event as InputEvent;

    let data: string | null = null;
    if (ie.inputType === "insertText") {
      data = ie.data ?? "";
    } else if (ie.inputType === "insertLineBreak" || ie.inputType === "insertParagraph") {
      data = "\r";
    } else if (ie.inputType === "deleteContentBackward") {
      data = "\x7f";
    }
    if (data === null) {
      return;
    }

    const path = event.composedPath();
    const container = findGhosttyContainer(path);
    if (!container) {
      return;
    }
    // Bug was confirmed at install time (cached in imeWorkaroundBugCache); the
    // check above against the module WeakMap is a pure lookup with no dispatch.
    if (!imeWorkaroundBugCache.get(container)) {
      return;
    }

    // Forward the committed text to ghostty's own compositionend listener.
    // ghostty's handleCompositionEnd calls onDataCallback(data) for non-empty
    // data, which is the PTY write path. Use bubbles:false so only listeners
    // on the container itself (ghostty's own) receive this synthetic event.
    const compositionEnd = new CompositionEvent("compositionend", {
      bubbles: false,
      cancelable: false,
      data,
    });
    container.dispatchEvent(compositionEnd);
  }

  parent.addEventListener("keydown", onKeyDown, { capture: true });
  parent.addEventListener("compositionstart", onCompositionStart, { capture: true });
  parent.addEventListener("compositionend", onCompositionEnd, { capture: true });
  parent.addEventListener("beforeinput", onBeforeInput, { capture: true });

  return () => {
    parent.removeEventListener("keydown", onKeyDown, true);
    parent.removeEventListener("compositionstart", onCompositionStart, true);
    parent.removeEventListener("compositionend", onCompositionEnd, true);
    parent.removeEventListener("beforeinput", onBeforeInput, true);
  };
}

/** Creates a terminal whose WASM memory is never reused by another tab. */
export async function createIsolatedGhosttyTerminal(options: CreateGhosttyTerminalOptions) {
  const [{ createGhosttyTerminal, loadGhosttyRuntime }, ghosttyModule] = await Promise.all([
    import("@openclaw/libterminal/browser"),
    import("ghostty-web"),
  ]);
  // ghostty-web 0.4.0 reuses freed WASM pages, exposing stale cells and corrupting
  // later terminals (coder/ghostty-web#142). Per-tab runtimes confine disposal.
  const runtime = await loadGhosttyRuntime({ module: ghosttyModule });
  const controller = await createGhosttyTerminal({ ...options, runtime, autoFit: false });
  const dispose = controller.dispose.bind(controller);
  const terminal = controller.terminal;
  const measurement = new runtime.FitAddon();
  measurement.activate(terminal);
  let observer: ResizeObserver | undefined;
  // Ghostty ignores defaultPrevented; its custom handler returns true to consume.
  // App capture listeners own dock shortcuts before they can become PTY input.
  terminal.attachCustomKeyEventHandler((event) => event.defaultPrevented);
  const mouseUpCandidate = asOptionalRecord(terminal)?.handleMouseUp;
  let handleMouseUp = isEventListener(mouseUpCandidate) ? mouseUpCandidate : undefined;
  let disposed = false;
  // Android soft-keyboard IME forwarding for ghostty-web 0.4.0 bug. See
  // installTerminalImeWorkaround for the full explanation and issue reference.
  const cleanupIme = installTerminalImeWorkaround(options.parent);
  // Ghostty 0.4.0 drops resize notifications during its 50ms fit lock. Measure
  // through its public addon, but let one owner apply every final layout size.
  controller.fit = () => {
    if (disposed) {
      return;
    }
    const size = measurement.proposeDimensions();
    if (size && (size.cols !== terminal.cols || size.rows !== terminal.rows)) {
      controller.resize({ columns: size.cols, rows: size.rows });
    }
  };
  controller.dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    observer?.disconnect();
    measurement.dispose();
    cleanupIme();
    // ghostty-web 0.4.0 clears isOpen before cleanup, skipping this listener removal.
    if (handleMouseUp) {
      document.removeEventListener("mouseup", handleMouseUp);
      handleMouseUp = undefined;
    }
    dispose();
  };
  if (options.signal?.aborted) {
    controller.dispose();
  } else if (options.autoFit !== false) {
    observer = new ResizeObserver(() => controller.fit());
    observer.observe(options.parent);
    if (!options.size) {
      controller.fit();
    }
  }
  return controller;
}
