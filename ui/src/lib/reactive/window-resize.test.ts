import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { observeWindowResize } from "./window-resize.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shares native delivery and independently releases duplicate registrations", () => {
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const callback = vi.fn();
  const first = observeWindowResize(window, callback);
  const second = observeWindowResize(window, callback);
  onTestFinished(first);
  onTestFinished(second);
  expect(add.mock.calls.filter(([type]) => type === "resize")).toHaveLength(1);
  window.dispatchEvent(new Event("resize"));
  expect(callback).toHaveBeenCalledTimes(2);
  first();
  first();
  window.dispatchEvent(new Event("resize"));
  expect(callback).toHaveBeenCalledTimes(3);
  expect(remove.mock.calls.filter(([type]) => type === "resize")).toHaveLength(0);
  second();
  expect(remove.mock.calls.filter(([type]) => type === "resize")).toHaveLength(1);
  window.dispatchEvent(new Event("resize"));
  expect(callback).toHaveBeenCalledTimes(3);
});

it("reports callback errors without preventing the next resize subscriber", () => {
  const report = vi.fn();
  vi.stubGlobal("reportError", report);
  const error = new Error("Resize callback failed");
  onTestFinished(
    observeWindowResize(window, () => {
      throw error;
    }),
  );
  const callback = vi.fn();
  onTestFinished(observeWindowResize(window, callback));
  window.dispatchEvent(new Event("resize"));
  expect(report).toHaveBeenCalledExactlyOnceWith(error);
  expect(callback).toHaveBeenCalledOnce();
});

it("keeps registrations in different windows independent", () => {
  const frame = document.body.appendChild(document.createElement("iframe"));
  onTestFinished(() => frame.remove());
  const otherWindow = frame.contentWindow!;
  const first = vi.fn();
  const second = vi.fn();
  const release = observeWindowResize(window, first);
  onTestFinished(release);
  onTestFinished(observeWindowResize(otherWindow, second));
  window.dispatchEvent(new Event("resize"));
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  otherWindow.dispatchEvent(new Event("resize"));
  expect(second).toHaveBeenCalledOnce();
  release();
  otherWindow.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new Event("resize"));
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledTimes(2);
});
