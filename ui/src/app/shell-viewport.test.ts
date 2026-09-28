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
  it("keeps ordinary layout resizes CSS-driven even before the scheduled frame", () => {
    disconnect = connectShellViewport();
    for (const next of [900, 1440, 844]) {
      vi.stubGlobal("innerHeight", next);
      Object.assign(viewport, { height: next });
      window.dispatchEvent(new Event("resize"));
      expect(height()).toBe("");
      flush();
      expect(height()).toBe("");
    }
    resize({ height: 843.9999 });
    expect(height()).toBe("");
  });

  it("ignores the shorter standalone layout viewport, focus alone and small browser bars", () => {
    root.style.setProperty("--shell-viewport-base", "100lvh");
    vi.stubGlobal("innerHeight", 796);
    viewport.height = 796;
    disconnect = connectShellViewport();
    editor();
    flush();
    expect(height()).toBe("");
    expect(inset()).toBe("");
    resize({ height: 756 });
    expect(height()).toBe("");
    expect(inset()).toBe("");
    resize({ height: 716 });
    expect(height()).toBe("716px");
    expect(inset()).toBe("0px");
  });

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
      expect(height()).toBe("");
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
    expect(height()).toBe("");
    expect(inset()).toBe("0px");
    vi.stubGlobal("innerHeight", 844);
    resize({ height: 844 });
    expect(height()).toBe("");
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
    expect(height()).toBe("");
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

  it("bounds visual occlusion without inventing a keyboard for a non-editor", () => {
    const button = document.createElement("input");
    button.type = "button";
    document.body.append(button);
    button.focus();
    disconnect = connectShellViewport();
    resize({ height: 480 });
    expect(height()).toBe("480px");
    expect(inset()).toBe("");
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
