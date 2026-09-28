import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { replaceComposerPopoverAnchor } from "../chat/components/chat-composer-dom.ts";
import { renderDebugOverlayFrame } from "./debug-overlay-frame.ts";

const key = "openclaw.debug-overlay.position";
let container: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
let reducedMotion = false;
const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
const capturePointer = vi.fn();
const storage = createStorageMock();

function flushFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(0));
}
async function mount(mode: "expanded" | "minimized" = "minimized", flush = true) {
  render(
    renderDebugOverlayFrame({
      mode,
      body: html`<div>Diagnostics</div>`,
      onClose: vi.fn(),
      onToggleMode: vi.fn(),
    }),
    container,
  );
  const panel = container.querySelector<HTMLElement>("aside")!;
  Object.defineProperties(panel, {
    offsetWidth: { configurable: true, get: () => 210 },
    offsetHeight: { configurable: true, get: () => 90 },
  });
  panel.getBoundingClientRect = () =>
    new DOMRect(
      Number.parseFloat(panel.style.left) || 800,
      Number.parseFloat(panel.style.top) || 600,
      210,
      90,
    );
  panel.setPointerCapture = capturePointer;
  panel.hasPointerCapture = () => false;
  panel.releasePointerCapture = vi.fn();
  Object.defineProperty(panel, "animate", { configurable: true, value: animate });
  await vi.dynamicImportSettled();
  if (flush) {
    flushFrame();
  }
  return panel;
}
function pointer(target: EventTarget, type: string, options: PointerEventInit = {}) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 810,
      clientY: 610,
      ...options,
    }),
  );
}

beforeEach(() => {
  storage.clear();
  frames = new Map();
  reducedMotion = false;
  animate.mockClear();
  capturePointer.mockClear();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  render(nothing, container);
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("System busyness frame layout", () => {
  it("does not initialize controls after their frame closes during import", async () => {
    render(
      renderDebugOverlayFrame({
        mode: "minimized",
        body: html`Loading`,
        onClose: vi.fn(),
        onToggleMode: vi.fn(),
      }),
      container,
    );
    render(nothing, container);
    await vi.dynamicImportSettled();
    expect(frames.size).toBe(0);
  });
  it("saves only a completed drag and restores it in a new frame", async () => {
    const panel = await mount();
    pointer(panel.querySelector("header")!, "pointerdown");
    pointer(panel, "pointermove", { clientX: 210, clientY: 160 });
    expect(panel.style.left).toBe("200px");
    expect(storage.getItem(key)).toBeNull();
    pointer(panel, "pointerup", { clientX: 210, clientY: 160 });
    expect(JSON.parse(storage.getItem(key)!)).toEqual({ x: 200, y: 150 });
    render(nothing, container);
    expect((await mount()).style.top).toBe("150px");
  });

  it.each(["pointercancel", "lostpointercapture"])(
    "rolls back %s and ignores unrelated pointers",
    async (ending) => {
      storage.setItem(key, JSON.stringify({ x: 200, y: 150 }));
      const panel = await mount();
      pointer(panel.querySelector("header")!, "pointerdown");
      pointer(panel, "pointermove", { pointerId: 2, clientX: 100, clientY: 100 });
      expect(panel.style.left).toBe("200px");
      pointer(panel, "pointermove", { clientX: 900, clientY: 700 });
      pointer(panel, ending);
      expect(panel.style.left).toBe("200px");
      expect(panel.style.top).toBe("150px");
      expect(JSON.parse(storage.getItem(key)!)).toEqual({ x: 200, y: 150 });
      expect(panel.classList.contains("debug-overlay--dragging")).toBe(false);
    },
  );

  it("leaves controls and secondary clicks alone and cleans up a removed frame", async () => {
    const composer = document.body.appendChild(document.createElement("div"));
    let composerTop = 500;
    composer.getBoundingClientRect = () => new DOMRect(0, composerTop, 100, 40);
    const anchor = replaceComposerPopoverAnchor(null, composer);
    const initialComposerHeight = composer.style.getPropertyValue(
      "--chat-composer-popover-max-height",
    );
    try {
      const panel = await mount();
      pointer(panel.querySelector("button")!, "pointerdown");
      pointer(panel.querySelector("header")!, "pointerdown", { button: 2 });
      expect(capturePointer).not.toHaveBeenCalled();
      pointer(panel.querySelector("header")!, "pointerdown");
      await mount("expanded", false);
      expect(frames.size).toBe(1);
      render(nothing, container);
      expect(frames.size).toBe(0);
      panel.style.left = "320px";
      panel.style.top = "240px";
      const detachedStyle = panel.style.cssText;
      pointer(panel, "pointermove", { clientX: 200 });
      composerTop = 300;
      window.dispatchEvent(new Event("resize"));
      expect(storage.getItem(key)).toBeNull();
      expect(panel.style.cssText).toBe(detachedStyle);
      flushFrame();
      expect(panel.style.cssText).toBe(detachedStyle);
    } finally {
      // Other resize owners must settle while this fixture still owns the frame queue.
      try {
        flushFrame();
      } finally {
        replaceComposerPopoverAnchor(anchor);
        composer.remove();
      }
    }
    expect(composer.style.getPropertyValue("--chat-composer-popover-max-height")).not.toBe(
      initialComposerHeight,
    );
  });

  it("keeps dragging usable when storage fails and rejects malformed stored coordinates", async () => {
    storage.setItem(key, '{"x":"200","y":150}');
    const panel = await mount();
    expect(panel.style.left).toBe("");
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("Unavailable");
    });
    pointer(panel.querySelector("header")!, "pointerdown");
    pointer(panel, "pointerup", { clientX: 210, clientY: 160 });
    expect(panel.style.left).toBe("200px");
  });

  it("animates mode changes for 160ms, but not mounting or reduced motion", async () => {
    await mount();
    expect(animate).not.toHaveBeenCalled();
    await mount("expanded");
    expect(animate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ duration: 160 }),
    );
    animate.mockClear();
    reducedMotion = true;
    await mount("minimized");
    expect(animate).not.toHaveBeenCalled();
  });

  it("keeps a queued transition and retargets an active one across same-mode content renders", async () => {
    await mount();
    await mount("expanded", false);
    await mount("expanded", false);
    expect(frames.size).toBe(1);
    flushFrame();
    expect(animate).toHaveBeenCalledTimes(1);
    const active = animate.mock.results[0]!.value;
    await mount("expanded");
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledTimes(2);
  });
});
