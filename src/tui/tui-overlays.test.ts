// Covers TUI overlay rendering and interaction state.
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createOverlayHandlers } from "./tui-overlays.js";

const createComponent = (): Component => ({ render: () => ["dummy"], invalidate() {} });

function createHandle(hide = vi.fn()) {
  return {
    hide,
    setHidden: vi.fn(),
    isHidden: vi.fn(() => false),
    focus: vi.fn(),
    unfocus: vi.fn(),
    isFocused: vi.fn(() => false),
    getBounds: () => undefined,
  } satisfies OverlayHandle;
}

describe("createOverlayHandlers", () => {
  it("routes overlays through the TUI overlay stack", () => {
    const showOverlay = vi.fn();
    const setFocus = vi.fn();
    const handle = createHandle();
    let open = false;

    const host = {
      showOverlay: (component: Component) => {
        open = true;
        showOverlay(component);
        return handle;
      },
      hasOverlay: () => open,
      hideOverlay: vi.fn(),
      setFocus,
    };

    const { openOverlay, closeOverlay } = createOverlayHandlers(host, createComponent());
    const overlay = createComponent();

    expect(openOverlay(overlay)).toBe(handle);
    expect(showOverlay).toHaveBeenCalledWith(overlay);

    closeOverlay(handle);
    expect(handle.hide).toHaveBeenCalledTimes(1);
    expect(setFocus).not.toHaveBeenCalled();
    expect(host.hideOverlay).not.toHaveBeenCalled();
  });

  it("restores fallback focus after nested handled overlays close", () => {
    let openCount = 2;
    const host = {
      showOverlay: vi.fn(),
      hideOverlay: vi.fn(),
      hasOverlay: () => openCount > 0,
      setFocus: vi.fn(),
    };
    const fallback = createComponent();
    const makeClosingHandle = () =>
      createHandle(
        vi.fn(() => {
          openCount -= 1;
        }),
      );
    const lowerOverlay = makeClosingHandle();
    const upperOverlay = makeClosingHandle();
    const { closeOverlay } = createOverlayHandlers(host, fallback);

    closeOverlay(lowerOverlay);
    expect(host.setFocus).not.toHaveBeenCalled();

    closeOverlay(upperOverlay);
    expect(host.setFocus).toHaveBeenCalledWith(fallback);
  });
});
