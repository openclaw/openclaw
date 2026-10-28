import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { BtwOverlay } from "./components/btw-overlay.js";
import { FilterableSelectList } from "./components/filterable-select-list.js";
import { QuestionPrompt } from "./components/question-prompt.js";
import { SearchableSelectList } from "./components/searchable-select-list.js";
import { SelectionCursor } from "./components/selection-cursor.js";

type OverlayHost = Pick<TUI, "showOverlay" | "hasOverlay" | "setFocus" | "setShowHardwareCursor">;

/**
 * Creates open/close handlers that restore focus when no overlay is active.
 * `screenReaderBell` doubles as the screen reader switch: it rings on open, shows the real
 * cursor, and makes overlays park that cursor on the selected row.
 */
export function createOverlayHandlers(
  host: OverlayHost,
  fallbackFocus: Component,
  screenReaderBell?: () => void,
) {
  if (screenReaderBell) {
    host.setShowHardwareCursor(true);
  }
  const closeOverlay = (handle: OverlayHandle) => {
    handle.hide();
    if (!host.hasOverlay()) {
      host.setFocus(fallbackFocus);
    }
  };

  const openOverlay: OverlayHost["showOverlay"] = (component, options) => {
    if (!screenReaderBell) {
      return host.showOverlay(component, options);
    }
    screenReaderBell();
    if (component instanceof SearchableSelectList || component instanceof FilterableSelectList) {
      component.stableWindow = true;
    }
    // A narrower overlay is spliced into chat rows, so a reader would also speak the earlier
    // messages sitting beside the options. Full-width rows replace them outright.
    // The btw answer and question prompt park their own cursor; their text may start lines with
    // an arrow.
    const parked =
      component instanceof BtwOverlay || component instanceof QuestionPrompt
        ? component
        : new SelectionCursor(component);
    return host.showOverlay(parked, {
      ...options,
      width: "100%",
      offsetX: 0,
      margin: 0,
    });
  };
  return { openOverlay, closeOverlay };
}
