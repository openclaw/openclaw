/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
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

function mouseDown(target: Element, init: MouseEventInit = {}, offsetY?: number) {
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (offsetY !== undefined) {
    Object.defineProperty(event, "offsetY", { value: offsetY });
  }
  target.dispatchEvent(event);
  return event;
}

it("drags the connecting skeleton while leaving startup status text selectable", () => {
  const postMessage = installBridge();
  const { container } = mountSolid(() =>
    createComponent(ConnectingSplash, { status: "Connecting to Gateway" }),
  );
  for (const selector of [".connect-splash__layout", ".loading-skeleton__message"]) {
    expect(mouseDown(container.querySelector(selector)!).defaultPrevented).toBe(true);
  }
  expect(postMessage).toHaveBeenLastCalledWith({ type: "window-drag" });
  expect(mouseDown(container.querySelector(".connect-splash__status")!).defaultPrevented).toBe(
    false,
  );
  expect(postMessage).toHaveBeenCalledTimes(2);
});

it.each(["secondary button", "handled", "no bridge"])("does not drag on %s", (reason) => {
  const postMessage = reason === "no bridge" ? undefined : installBridge();
  const event = new MouseEvent("mousedown", {
    cancelable: true,
    button: reason === "secondary button" ? 2 : 0,
  });
  if (reason === "handled") {
    event.preventDefault();
  }
  beginNativeWindowDrag(event);
  if (postMessage) {
    expect(postMessage).not.toHaveBeenCalled();
  }
  expect(event.defaultPrevented).toBe(reason === "handled");
});
it.each([
  ["bare top padding", false, 20, true],
  ["below the padding band", false, 60, false],
  ["content inside the band", true, 20, false],
] as const)("handles presses on %s", (_name, onContent, offsetY, drags) => {
  const postMessage = installBridge();
  const thread = document.body.appendChild(document.createElement("div"));
  thread.style.paddingTop = "44px";
  const inner = thread.appendChild(document.createElement("div"));
  thread.addEventListener("mousedown", beginNativeWindowDragFromTopInset);
  const event = mouseDown(onContent ? inner : thread, {}, offsetY);
  expect(postMessage.mock.calls).toEqual(drags ? [[{ type: "window-drag" }]] : []);
  expect(event.defaultPrevented).toBe(drags);
});
