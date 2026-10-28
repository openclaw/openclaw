// Covers TUI overlay rendering and interaction state.
import {
  CURSOR_MARKER,
  type Component,
  type Focusable,
  type OverlayHandle,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { BtwOverlay } from "./components/btw-overlay.js";
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
      setShowHardwareCursor: vi.fn(),
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
      setShowHardwareCursor: vi.fn(),
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

describe("createOverlayHandlers in screen reader mode", () => {
  it("rings the bell, shows the real cursor and wraps overlays", () => {
    const shown: Component[] = [];
    const host = {
      showOverlay: vi.fn((component: Component) => {
        shown.push(component);
        return createHandle();
      }),
      hasOverlay: () => false,
      setFocus: vi.fn(),
      setShowHardwareCursor: vi.fn(),
    };
    const bell = vi.fn();
    const { openOverlay } = createOverlayHandlers(host, createComponent(), bell);
    expect(host.setShowHardwareCursor).toHaveBeenCalledWith(true);
    const overlay = createComponent();
    openOverlay(overlay);
    expect(bell).toHaveBeenCalledTimes(1);
    expect(shown[0]).not.toBe(overlay);
    expect(host.showOverlay).toHaveBeenCalledWith(expect.anything(), {
      width: "100%",
      offsetX: 0,
      margin: 0,
    });
    expect(shown[0]?.render(20)).toEqual(["dummy"]);
  });

  it("keeps the btw answer cursor on the answer when a line starts with an arrow", () => {
    const shown: Array<Component & Partial<Focusable>> = [];
    const host = {
      showOverlay: vi.fn((component: Component) => {
        shown.push(component);
        return createHandle();
      }),
      hasOverlay: () => false,
      setFocus: vi.fn(),
      setShowHardwareCursor: vi.fn(),
    };
    const { openOverlay } = createOverlayHandlers(host, createComponent(), vi.fn());
    const overlay = new BtwOverlay(
      { question: "flow?", text: "Steps:\n→ build\n→ ship" },
      { close() {}, copy: async () => true, requestRender() {} },
    );
    openOverlay(overlay);
    const opened = shown[0];
    if (!opened) {
      throw new Error("overlay not shown");
    }
    opened.focused = true;
    const lines = opened.render(60).map((line) => line.trimEnd());
    expect(lines[0]).toBe(`${CURSOR_MARKER}Your btw answer: Steps:`);
    expect(lines).toContain("→ build");
  });

  it("leaves the cursor and overlays alone by default", () => {
    const host = {
      showOverlay: vi.fn(() => createHandle()),
      hasOverlay: () => false,
      setFocus: vi.fn(),
      setShowHardwareCursor: vi.fn(),
    };
    const overlay = createComponent();
    createOverlayHandlers(host, createComponent()).openOverlay(overlay);
    expect(host.setShowHardwareCursor).not.toHaveBeenCalled();
    expect(host.showOverlay).toHaveBeenCalledWith(overlay, undefined);
  });
});
