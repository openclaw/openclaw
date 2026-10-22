import type { CreateGhosttyTerminalOptions } from "@openclaw/libterminal/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import { showToast } from "../../lib/toast.ts";
import { observeTerminalFonts } from "./terminal-fonts.ts";

function isEventListener(value: unknown): value is EventListener {
  return typeof value === "function";
}

/** Creates a terminal whose WASM memory is never reused by another tab. */
export async function createIsolatedGhosttyTerminal(
  options: CreateGhosttyTerminalOptions,
  shouldFocusOnOpen?: () => boolean,
) {
  const [{ createGhosttyTerminal, loadGhosttyRuntime }, ghosttyModule] = await Promise.all([
    import("@openclaw/libterminal/browser"),
    import("ghostty-web"),
  ]);
  // ghostty-web 0.4.0 reuses freed WASM pages, exposing stale cells and corrupting
  // later terminals (coder/ghostty-web#142). Per-tab runtimes confine disposal.
  const runtime = await loadGhosttyRuntime({ module: ghosttyModule });
  if (shouldFocusOnOpen) {
    let focusOnOpen: (() => boolean) | undefined = shouldFocusOnOpen;
    const Terminal = runtime.Terminal;
    runtime.Terminal = class extends Terminal {
      private opening = false;

      override open(parent: HTMLElement) {
        this.opening = true;
        try {
          super.open(parent);
        } finally {
          this.opening = false;
          // Adopted views and later explicit focus must not retain the boot owner's policy.
          focusOnOpen = undefined;
        }
      }

      override focus() {
        // Ghostty's open() focus also schedules a second, unconditional focus task.
        if (!this.opening || focusOnOpen?.() !== false) {
          super.focus();
        }
      }
    };
  }
  let disposed = false;
  const controller = await createGhosttyTerminal({
    ...options,
    runtime,
    autoFit: false,
    terminalOptions: {
      ...options.terminalOptions,
      // Selection changes fire before clipboard completion; the patched callback confirms success.
      onCopy: () => {
        if (disposed || options.signal?.aborted || !options.parent.checkVisibility()) {
          return;
        }
        showToast({
          message: t("terminal.copiedToClipboard"),
          anchor: options.parent,
          durationMs: 2_000,
        });
      },
    },
  });
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
  let stopObservingFonts: (() => void) | undefined;
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
    stopObservingFonts?.();
    measurement.dispose();
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
  if (!disposed) {
    stopObservingFonts = observeTerminalFonts(
      controller,
      options.autoFit !== false && !options.size,
    );
  }
  return controller;
}
