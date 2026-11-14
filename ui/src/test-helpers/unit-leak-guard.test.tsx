import { Portal } from "@solidjs/web";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listen } from "../lib/reactive/listener.ts";
import { cleanupSolid, mountSolid } from "./mount-solid.ts";
import { beginUiLeakCheck, reportUiLeaks } from "./unit-leak-guard.ts";

let restoreAttributes: () => void;

beforeEach(() => {
  const attributes = [document.body, document.documentElement].flatMap((element) =>
    ["style", "class"].map((name) => ({ element, name, value: element.getAttribute(name) })),
  );
  restoreAttributes = () => {
    for (const { element, name, value } of attributes) {
      if (value === null) {
        element.removeAttribute(name);
      } else {
        element.setAttribute(name, value);
      }
    }
  };
});

function cleanup() {
  cleanupSolid();
  document.body.replaceChildren();
  restoreAttributes();
  vi.useRealTimers();
  vi.restoreAllMocks();
}

afterEach(cleanup);

it.each([
  { name: "body child", leak: () => document.body.append(document.createElement("aside")) },
  {
    name: "body inline style",
    leak: () => {
      document.body.style.pointerEvents = "none";
    },
  },
  {
    name: "body class",
    leak: () => {
      document.body.className = "scroll-locked";
    },
  },
  {
    name: "html inline style",
    leak: () => {
      document.documentElement.style.overflow = "hidden";
    },
  },
  {
    name: "html class",
    leak: () => {
      document.documentElement.className = "scroll-locked";
    },
  },
  { name: "fake timers", leak: () => vi.useFakeTimers() },
])("attributes $name to the leaking test", ({ name, leak }) => {
  const check = beginUiLeakCheck();
  leak();
  const leaks = check();
  expect(leaks).toEqual([expect.stringContaining(name)]);
  expect(() => reportUiLeaks("offending test", leaks, "fail")).toThrow("offending test");
  cleanup();
  expect(check()).toEqual([]);
});

it("reports a live portal and dialog, and accepts their owner cleanup", () => {
  const check = beginUiLeakCheck();
  mountSolid(() => (
    <Portal>
      <dialog open>Overlay</dialog>
    </Portal>
  ));
  const leaks = check();
  expect(leaks).toContainEqual(expect.stringContaining("body child"));
  expect(() => reportUiLeaks("offending portal", leaks, "fail")).toThrow("offending portal");
  cleanupSolid();
  expect(check()).toEqual([]);
});

it("detects helper-owned global listeners but accepts remove, abort and once completion", () => {
  const check = beginUiLeakCheck();
  const stop = listen(window, "leak-probe", () => {});
  const leaks = check();
  stop();
  expect(leaks).toContain("window listener leak-probe");
  expect(() => reportUiLeaks("offending listener", leaks, "fail")).toThrow("offending listener");

  const clean = beginUiLeakCheck();
  const controller = new AbortController();
  listen(document, "abort-probe", () => {}, { signal: controller.signal });
  controller.abort();
  listen(window, "once-probe", () => {}, { once: true });
  window.dispatchEvent(new Event("once-probe"));
  const remove = listen(document, "removed-probe", () => {}, true);
  remove();
  const callback = vi.fn();
  const oldScope = new AbortController();
  listen(document, "reused-probe", callback, { once: true, signal: oldScope.signal });
  oldScope.abort();
  const stopReused = listen(document, "reused-probe", callback, { once: true });
  listen(document, "reused-probe", callback);
  stopReused();
  document.dispatchEvent(new Event("reused-probe"));
  expect(callback).not.toHaveBeenCalled();
  expect(clean()).toEqual([]);
});

it("tracks pointer capture until it is released", () => {
  const target = document.body.appendChild(document.createElement("div"));
  const pointer = (type: string) =>
    Object.assign(new Event(type, { bubbles: true }), { pointerId: 7 });
  const check = beginUiLeakCheck();
  target.dispatchEvent(pointer("gotpointercapture"));
  const leaks = check();
  expect(leaks).toEqual(["pointer capture 7 on <div>"]);
  expect(() => reportUiLeaks("offending pointer", leaks, "fail")).toThrow("offending pointer");
  const released = beginUiLeakCheck();
  target.dispatchEvent(pointer("gotpointercapture"));
  target.dispatchEvent(pointer("lostpointercapture"));
  expect(released()).toEqual([]);
});

it("reports diagnostics without failing in report mode", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  reportUiLeaks("file > test", ["body child <dialog>"]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("file > test"));
});

it("accepts native null listener options without changing dispatch or removal", () => {
  const check = beginUiLeakCheck();
  const callback = vi.fn();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  Reflect.apply(add, undefined, ["null-options", callback, null]);
  expect(check()).toContain("#document listener null-options");
  document.dispatchEvent(new Event("null-options"));
  expect(callback).toHaveBeenCalledOnce();
  Reflect.apply(remove, undefined, ["null-options", callback, null]);
  expect(check()).toEqual([]);
});

it("does not attribute inherited fake timers to a later test", () => {
  vi.useFakeTimers();
  const check = beginUiLeakCheck();
  expect(check()).toEqual([]);
});

it("checks fake timers without a document", () => {
  vi.stubGlobal("document", undefined);
  try {
    const check = beginUiLeakCheck();
    vi.useFakeTimers();
    expect(check()).toEqual(["fake timers still installed"]);
    vi.useRealTimers();
    expect(check()).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});
