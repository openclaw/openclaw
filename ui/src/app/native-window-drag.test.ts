/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectingSplash } from "../components/solid/loading-skeleton.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  beginNativeWindowDrag,
  beginNativeWindowDragFromTopInset,
  beginNativeWindowDragFromTitlebar,
} from "./native-window-drag.ts";

it("drags blank native titlebar descendants but leaves controls and page content alone", () => {
  const postMessage = installBridge();
  vi.stubGlobal("__OPENCLAW_NATIVE_WEB_CHROME__", true);
  document.documentElement.classList.add("openclaw-native-macos");
  try {
    const shell = document.body.appendChild(document.createElement("div"));
    shell.style.setProperty("--openclaw-native-titlebar-height", "40px");
    shell.addEventListener("mousedown", beginNativeWindowDragFromTitlebar);
    const blank = shell.appendChild(document.createElement("span"));
    const button = shell.appendChild(document.createElement("button"));
    expect(mouseDown(blank, { clientY: 20 }).defaultPrevented).toBe(true);
    expect(mouseDown(button, { clientY: 20 }).defaultPrevented).toBe(false);
    expect(mouseDown(blank, { clientY: 60 }).defaultPrevented).toBe(false);
    expect(postMessage).toHaveBeenCalledTimes(1);
  } finally {
    document.documentElement.classList.remove("openclaw-native-macos");
  }
});

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
