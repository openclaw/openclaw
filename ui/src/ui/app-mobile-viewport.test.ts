import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachMobileViewportFixes } from "./app-mobile-viewport.ts";

class MockVisualViewport extends EventTarget {
  width: number;
  height: number;

  constructor(width: number, height: number) {
    super();
    this.width = width;
    this.height = height;
  }

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
const originalUserAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
const originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, "platform");
const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(window.navigator, "maxTouchPoints");
const originalResizeObserver = globalThis.ResizeObserver;

function restoreProperty(target: object, key: string, descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  Reflect.deleteProperty(target, key);
}

function createHost() {
  const host = document.createElement("openclaw-app") as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  host.updateComplete = Promise.resolve();
  host.innerHTML = `
    <div class="content--chat">
      <div class="agent-chat__input">
        <textarea></textarea>
      </div>
    </div>
  `;
  const input = host.querySelector<HTMLElement>(".agent-chat__input");
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea");
  if (!input || !textarea) {
    throw new Error("failed to create mobile viewport test host");
  }
  Object.defineProperty(input, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({
        width: 320,
        height: 72,
        top: 0,
        left: 0,
        right: 320,
        bottom: 72,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) satisfies Partial<DOMRect>,
  });
  document.body.append(host);
  return { host, textarea };
}

async function flushViewportWork() {
  await Promise.resolve();
  vi.runAllTimers();
  await Promise.resolve();
}

function createBlurTarget() {
  const button = document.createElement("button");
  button.type = "button";
  document.body.append(button);
  return button;
}

describe("attachMobileViewportFixes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    });
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "iPhone",
    });
    Object.defineProperty(window.navigator, "maxTouchPoints", {
      configurable: true,
      value: 5,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: new MockVisualViewport(400, 800),
    });
    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-ios-mobile");
    document.documentElement.removeAttribute("data-ios-keyboard-open");
    document.documentElement.removeAttribute("data-ios-shell-lock");
    document.body.removeAttribute("data-ios-mobile");
    document.body.removeAttribute("data-ios-keyboard-open");
    document.body.removeAttribute("data-ios-shell-lock");
    document.documentElement.style.removeProperty("--mobile-layout-height");
    document.documentElement.style.removeProperty("--mobile-viewport-height");
    document.documentElement.style.removeProperty("--mobile-chat-input-height");
    restoreProperty(window, "visualViewport", originalVisualViewport);
    restoreProperty(window.navigator, "userAgent", originalUserAgent);
    restoreProperty(window.navigator, "platform", originalPlatform);
    restoreProperty(window.navigator, "maxTouchPoints", originalMaxTouchPoints);
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it("does not treat an unfocused viewport shrink as keyboard open", async () => {
    const { host } = createHost();
    const controller = attachMobileViewportFixes(host);
    const viewport = window.visualViewport as unknown as MockVisualViewport;
    const blurTarget = createBlurTarget();

    blurTarget.focus();
    expect(document.activeElement).toBe(blurTarget);

    viewport.setSize(400, 620);
    viewport.dispatchEvent(new Event("resize"));
    await flushViewportWork();

    expect(document.documentElement.hasAttribute("data-ios-keyboard-open")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--mobile-layout-height")).toBe("620px");

    controller.cleanup();
  });

  it("preserves the pre-keyboard layout height while a text field is focused", async () => {
    const { host, textarea } = createHost();
    const controller = attachMobileViewportFixes(host);
    const viewport = window.visualViewport as unknown as MockVisualViewport;

    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    viewport.setSize(400, 560);
    viewport.dispatchEvent(new Event("resize"));
    await flushViewportWork();

    expect(document.documentElement.hasAttribute("data-ios-keyboard-open")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--mobile-layout-height")).toBe("800px");

    controller.cleanup();
  });

  it("keeps the pre-keyboard baseline stable across incremental keyboard resizes", async () => {
    const { host, textarea } = createHost();
    const controller = attachMobileViewportFixes(host);
    const viewport = window.visualViewport as unknown as MockVisualViewport;

    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    viewport.setSize(400, 730);
    viewport.dispatchEvent(new Event("resize"));
    await flushViewportWork();

    expect(document.documentElement.hasAttribute("data-ios-keyboard-open")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--mobile-layout-height")).toBe("730px");

    viewport.setSize(400, 560);
    viewport.dispatchEvent(new Event("resize"));
    await flushViewportWork();

    expect(document.documentElement.hasAttribute("data-ios-keyboard-open")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--mobile-layout-height")).toBe("800px");

    controller.cleanup();
  });

  it("resets the keyboard baseline after orientation changes", async () => {
    const { host, textarea } = createHost();
    const controller = attachMobileViewportFixes(host);
    const viewport = window.visualViewport as unknown as MockVisualViewport;
    const blurTarget = createBlurTarget();

    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    viewport.setSize(400, 560);
    viewport.dispatchEvent(new Event("resize"));
    await flushViewportWork();
    expect(document.documentElement.hasAttribute("data-ios-keyboard-open")).toBe(true);

    blurTarget.focus();
    expect(document.activeElement).toBe(blurTarget);
    viewport.setSize(800, 360);
    window.dispatchEvent(new Event("orientationchange"));
    await flushViewportWork();

    expect(document.documentElement.hasAttribute("data-ios-keyboard-open")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--mobile-layout-height")).toBe("360px");

    controller.cleanup();
  });

  it("does not snap document scroll when the shell lock is inactive", async () => {
    const { host } = createHost();
    const controller = attachMobileViewportFixes(host);
    const viewport = window.visualViewport as unknown as MockVisualViewport;
    const scrollingElement = document.scrollingElement ?? document.documentElement;

    scrollingElement.scrollTop = 240;
    viewport.dispatchEvent(new Event("scroll"));
    await flushViewportWork();

    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(scrollingElement.scrollTop).toBe(240);

    controller.cleanup();
  });

  it("restores document scroll after iOS viewport changes while the shell is locked", async () => {
    const { host } = createHost();
    const controller = attachMobileViewportFixes(host);
    const viewport = window.visualViewport as unknown as MockVisualViewport;
    const scrollingElement = document.scrollingElement ?? document.documentElement;

    controller.setShellLocked(true);
    scrollingElement.scrollTop = 240;
    viewport.dispatchEvent(new Event("scroll"));
    await flushViewportWork();

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
    expect(scrollingElement.scrollTop).toBe(0);

    controller.cleanup();
  });
});
