import { createSignal, type Setter } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { DebugOverlayFrame } from "./debug-overlay-frame-view.tsx";

const key = "openclaw.debug-overlay.position";
let setMode: Setter<"expanded" | "minimized">;
let mounted: ReturnType<typeof mountSolid> | undefined;
const controls = { onClose: vi.fn(), onToggleMode: vi.fn() };
const position = (value: string, fallback: number) => Number.parseFloat(value) || fallback;

function disposeFrame() {
  mounted?.unmount();
  mounted = undefined;
}

async function mount(nextMode: "expanded" | "minimized" = "minimized", settleFrame = true) {
  if (!mounted) {
    const [mode, updateMode] = createSignal(nextMode);
    setMode = updateMode;
    mounted = mountSolid(() => <DebugOverlayFrame mode={mode()} body="" {...controls} />);
  }
  setMode(nextMode);
  flush();
  const panel = mounted.container.querySelector<HTMLElement>("aside")!;
  panel.getBoundingClientRect = () =>
    new DOMRect(position(panel.style.left, 800), position(panel.style.top, 600), 210, 90);
  panel.setPointerCapture = () => {};
  panel.hasPointerCapture = () => false;
  Object.defineProperty(panel, "animate", { configurable: true, value: animate });
  await vi.dynamicImportSettled();
  if (settleFrame) {
    vi.advanceTimersToNextFrame();
  }
  return panel;
}
let reducedMotion = false;
const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
const storage = createStorageMock();
const pointerDefaults = { bubbles: true, isPrimary: true, clientX: 810, clientY: 610 };

function pointer(target: EventTarget, type: string, options: PointerEventInit = {}) {
  const event = new PointerEvent(type, { cancelable: true, ...pointerDefaults, ...options });
  return target.dispatchEvent(event);
}

beforeEach(() => {
  storage.clear();
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  reducedMotion = false;
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
});
afterEach(() => {
  disposeFrame();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not initialize controls after their frame closes during import", async () => {
  const pending = mount("minimized", false);
  disposeFrame();
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});
it("rolls back pointercancel and ignores unrelated pointers", async () => {
  storage.setItem(key, JSON.stringify({ x: 200, y: 150 }));
  const panel = await mount();
  expect(pointer(panel.querySelector("header")!, "pointerdown")).toBe(false);
  pointer(panel, "pointermove", { pointerId: 2, clientX: 100, clientY: 100 });
  expect(panel.style.left).toBe("200px");
  pointer(panel, "pointermove", { clientX: 900, clientY: 700 });
  pointer(panel, "pointercancel");
  expect(panel.style).toMatchObject({ left: "200px", top: "150px" });
  expect(JSON.parse(storage.getItem(key)!)).toEqual({ x: 200, y: 150 });
  expect(panel.classList.contains("debug-overlay--dragging")).toBe(false);
});

it("leaves controls and secondary clicks alone and cleans up a removed frame", async () => {
  const onResize = vi.fn();
  window.addEventListener("resize", onResize);
  onTestFinished(() => window.removeEventListener("resize", onResize));
  const panel = await mount();
  expect(pointer(panel.querySelector("button")!, "pointerdown")).toBe(true);
  expect(pointer(panel.querySelector("header")!, "pointerdown", { button: 2 })).toBe(true);
  pointer(panel.querySelector("header")!, "pointerdown");
  await mount("expanded", false);
  expect(vi.getTimerCount()).toBe(1);
  disposeFrame();
  expect(vi.getTimerCount()).toBe(0);
  Object.assign(panel.style, { left: "320px", top: "240px" });
  const detachedStyle = panel.style.cssText;
  pointer(panel, "pointermove", { clientX: 200 });
  window.dispatchEvent(new Event("resize"));
  expect(storage.getItem(key)).toBeNull();
  expect(panel.style.cssText).toBe(detachedStyle);
  vi.advanceTimersToNextFrame();
  expect(panel.style.cssText).toBe(detachedStyle);
  expect(onResize).toHaveBeenCalledOnce();
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

it("coalesces mode changes into one animation, except with reduced motion", async () => {
  await mount();
  expect(animate).not.toHaveBeenCalled();
  await mount("expanded", false);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersToNextFrame();
  expect(animate).toHaveBeenCalledOnce();
  animate.mockClear();
  reducedMotion = true;
  await mount("minimized");
  expect(animate).not.toHaveBeenCalled();
});
