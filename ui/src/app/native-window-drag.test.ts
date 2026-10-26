/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectingSplash } from "../components/solid/loading-skeleton.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { beginNativeWindowDrag, beginNativeWindowDragFromTopInset } from "./native-window-drag.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function installBridge() {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawWindowDrag: { postMessage } } });
  return postMessage;
}

function buildHeader() {
  const header = document.createElement("div");
  const button = document.createElement("button");
  button.type = "button";
  header.append(button);
  header.addEventListener("mousedown", beginNativeWindowDrag);
  document.body.append(header);
  return { header, button };
}

function mouseDown(target: Element, init: MouseEventInit = {}, offsetY?: number) {
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    ...init,
  });
  if (offsetY !== undefined) {
    Object.defineProperty(event, "offsetY", { value: offsetY });
  }
  target.dispatchEvent(event);
  return event;
}

describe("native window drag", () => {
  it("drags the connecting skeleton while leaving startup status text selectable", () => {
    const postMessage = installBridge();
    const { container } = mountSolid(() =>
      createComponent(ConnectingSplash, { status: "Connecting to Gateway" }),
    );
    for (const selector of [".connect-splash__layout", ".loading-skeleton__message"]) {
      expect(mouseDown(container.querySelector(selector)!).defaultPrevented).toBe(true);
    }
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "window-drag" });
    expect(mouseDown(container.querySelector(".connect-splash__status")!).defaultPrevented).toBe(
      false,
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it("leaves presses on interactive children alone", () => {
    const postMessage = installBridge();
    const { button } = buildHeader();
    const event = mouseDown(button);
    expect(postMessage).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores secondary buttons and already-handled presses", () => {
    const postMessage = installBridge();
    const { header } = buildHeader();
    mouseDown(header, { button: 2 });
    const handled = new MouseEvent("mousedown", { cancelable: true, button: 0 });
    handled.preventDefault();
    beginNativeWindowDrag(handled);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("keeps default behavior without the WebKit bridge", () => {
    const { header } = buildHeader();
    const event = mouseDown(header);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("native window drag from top inset", () => {
  it.each([
    ["bare top padding", false, 20, true],
    ["below the padding band", false, 60, false],
    ["content inside the band", true, 20, false],
  ] as const)("handles presses on %s", (_name, onContent, offsetY, drags) => {
    const postMessage = installBridge();
    const thread = document.createElement("div");
    thread.style.paddingTop = "44px";
    const inner = document.createElement("div");
    thread.append(inner);
    thread.addEventListener("mousedown", beginNativeWindowDragFromTopInset);
    document.body.append(thread);
    const event = mouseDown(onContent ? inner : thread, {}, offsetY);
    expect(postMessage.mock.calls).toEqual(drags ? [[{ type: "window-drag" }]] : []);
    expect(event.defaultPrevented).toBe(drags);
  });
});
