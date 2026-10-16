/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectShellViewport } from "./shell-viewport.ts";

let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
let disconnect: (() => void) | undefined;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
const root = document.documentElement;
const height = () => root.style.getPropertyValue("--shell-viewport-height");
const inset = () => root.style.getPropertyValue("--shell-safe-area-bottom");
function flush() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) {
    callback(0);
  }
}
function resize(values: Partial<typeof viewport>, event = "resize") {
  Object.assign(viewport, values);
  viewport.dispatchEvent(new Event(event));
  flush();
}
function editor(shadow = false) {
  const input = document.createElement("textarea");
  if (shadow) {
    const host = document.createElement("div");
    document.body.append(host);
    host.attachShadow({ mode: "open" }).append(input);
  } else {
    document.body.append(input);
  }
  input.focus();
  return input;
}

beforeEach(() => {
  viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  frames = new Map();
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => {
  disconnect?.();
  disconnect = undefined;
  document.body.replaceChildren();
  root.style.removeProperty("--shell-viewport-base");
  vi.unstubAllGlobals();
});

describe("shell visual viewport", () => {
  it.each([
    { focus: "none", heights: [900, 1440, 844], layoutResize: true },
    { focus: "none", heights: [782], layoutResize: false },
    { focus: "editor", heights: [782], layoutResize: false },
    { focus: "button", heights: [480], layoutResize: false },
  ])(
    "bounds $focus occlusion without inventing a keyboard ($heights)",
    ({ focus, heights, layoutResize }) => {
      if (focus === "button") {
        const button = document.createElement("input");
        button.type = "button";
        document.body.append(button);
        button.focus();
      }
      disconnect = connectShellViewport();
      if (focus === "editor") {
        editor();
        flush();
      }
      for (const next of heights) {
        if (layoutResize) {
          vi.stubGlobal("innerHeight", next);
          Object.assign(viewport, { height: next });
          window.dispatchEvent(new Event("resize"));
          flush();
        } else {
          resize({ height: next });
        }
        expect(height()).toBe(`${next}px`);
        expect(inset()).toBe("");
        if (next === 782) {
          resize({ height: 770, offsetTop: 12 }, "scroll");
          expect(height()).toBe("782px");
          expect(inset()).toBe("");
        }
      }
    },
  );

  it.each([false, true])(
    "tracks keyboard pan and dismissal with retained focus (shadow: %s)",
    (shadow) => {
      disconnect = connectShellViewport();
      const input = editor(shadow);
      resize({ height: 480 });
      expect(height()).toBe("480px");
      expect(inset()).toBe("0px");
      resize({ height: 440, offsetTop: 70 }, "scroll");
      expect(height()).toBe("510px");
      resize({ height: 844, offsetTop: 0 });
      expect(height()).toBe("844px");
      expect(inset()).toBe("");
      expect(input.matches(":focus")).toBe(true);
    },
  );

  it("captures focus before a content-resizing keyboard and restores its inset", () => {
    disconnect = connectShellViewport();
    editor();
    // The browser can resize both viewports before the first focus frame.
    vi.stubGlobal("innerHeight", 480);
    resize({ height: 480 });
    expect(height()).toBe("480px");
    expect(inset()).toBe("0px");
    vi.stubGlobal("innerHeight", 844);
    resize({ height: 844 });
    expect(height()).toBe("844px");
    expect(inset()).toBe("");
  });

  it("does not carry portrait keyboard geometry into landscape", () => {
    disconnect = connectShellViewport();
    editor();
    resize({ height: 480 });
    vi.stubGlobal("innerWidth", 844);
    vi.stubGlobal("innerHeight", 390);
    resize({ height: 390 });
    window.dispatchEvent(new Event("orientationchange"));
    flush();
    expect(height()).toBe("390px");
    expect(inset()).toBe("");
    resize({ height: 210 });
    expect(height()).toBe("210px");
    expect(inset()).toBe("0px");
  });

  it("leaves pinch zoom and panning to the browser, including while focused", () => {
    disconnect = connectShellViewport();
    editor();
    resize({ height: 480 });
    resize({ height: 422, scale: 2, offsetTop: 50 });
    expect(height()).toBe("");
    expect(inset()).toBe("");
    resize({ height: 480, scale: 1, offsetTop: 0 });
    expect(height()).toBe("480px");
  });

  it("coalesces events, removes root overrides, and releases every listener on disconnect", () => {
    disconnect = connectShellViewport();
    editor();
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    flush();
    resize({ height: 480 });
    window.dispatchEvent(new Event("resize"));
    disconnect();
    expect(frames.size).toBe(0);
    expect(height()).toBe("");
    expect(inset()).toBe("");
    resize({ height: 300 });
    window.dispatchEvent(new Event("orientationchange"));
    document.dispatchEvent(new Event("focusin"));
    document.dispatchEvent(new Event("focusout"));
    expect(frames.size).toBe(0);
    disconnect = connectShellViewport();
    expect(height()).toBe("300px");
  });

  it("retains the CSS fallback without VisualViewport", () => {
    vi.stubGlobal("visualViewport", undefined);
    disconnect = connectShellViewport();
    editor();
    window.dispatchEvent(new Event("resize"));
    expect(height()).toBe("");
    expect(inset()).toBe("");
    expect(frames.size).toBe(0);
  });
});
