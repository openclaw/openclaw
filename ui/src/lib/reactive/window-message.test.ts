import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { observeWindowMessage } from "./window-message.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sourceWindow(): Window {
  const frame = document.body.appendChild(document.createElement("iframe"));
  onTestFinished(() => frame.remove());
  return frame.contentWindow!;
}

it("shares one native listener and routes only the exact registered source", () => {
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const firstSource = sourceWindow();
  const secondSource = sourceWindow();
  const first = vi.fn();
  const second = vi.fn();
  const releaseFirst = observeWindowMessage(window, firstSource, first);
  const releaseSecond = observeWindowMessage(window, secondSource, second);
  onTestFinished(releaseFirst);
  onTestFinished(releaseSecond);
  expect(add.mock.calls.filter(([type]) => type === "message")).toHaveLength(1);
  const event = new MessageEvent("message", { source: firstSource, data: "first" });
  window.dispatchEvent(event);
  window.dispatchEvent(new MessageEvent("message", { source: window, data: "unknown" }));
  expect(first).toHaveBeenCalledExactlyOnceWith(event);
  expect(second).not.toHaveBeenCalled();
  releaseFirst();
  releaseFirst();
  expect(remove.mock.calls.filter(([type]) => type === "message")).toHaveLength(0);
  window.dispatchEvent(new MessageEvent("message", { source: firstSource }));
  window.dispatchEvent(new MessageEvent("message", { source: secondSource }));
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  releaseSecond();
  expect(remove.mock.calls.filter(([type]) => type === "message")).toHaveLength(1);
});

it("keeps duplicate subscriptions independent and isolates callback failures", () => {
  const source = sourceWindow();
  const report = vi.fn();
  vi.stubGlobal("reportError", report);
  const failure = new Error("Frame callback failed");
  const callback = vi.fn();
  onTestFinished(
    observeWindowMessage(window, source, () => {
      throw failure;
    }),
  );
  const release = observeWindowMessage(window, source, callback);
  onTestFinished(release);
  onTestFinished(observeWindowMessage(window, source, callback));
  window.dispatchEvent(new MessageEvent("message", { source }));
  expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  expect(callback).toHaveBeenCalledTimes(2);
  release();
  window.dispatchEvent(new MessageEvent("message", { source }));
  expect(callback).toHaveBeenCalledTimes(3);
});

it("keeps the receiving window scoped and skips subscriptions retired during delivery", () => {
  const receiver = sourceWindow();
  const source = sourceWindow();
  const retired = vi.fn();
  let releaseRetired = () => {};
  onTestFinished(observeWindowMessage(window, source, () => releaseRetired()));
  releaseRetired = observeWindowMessage(window, source, retired);
  onTestFinished(releaseRetired);
  const otherReceiver = vi.fn();
  onTestFinished(observeWindowMessage(receiver, source, otherReceiver));
  window.dispatchEvent(new MessageEvent("message", { source }));
  expect(retired).not.toHaveBeenCalled();
  expect(otherReceiver).not.toHaveBeenCalled();
  receiver.dispatchEvent(new MessageEvent("message", { source }));
  expect(otherReceiver).toHaveBeenCalledOnce();
});
