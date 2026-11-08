/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPdfPreviewWorker } from "./chat-pdf-worker.ts";

class ControlledWorker extends EventTarget {
  static current: ControlledWorker;
  sent: unknown[] = [];
  terminate = vi.fn();
  constructor(readonly url: string) {
    super();
    ControlledWorker.current = this;
  }
  postMessage(data: unknown, transfer?: Transferable[]) {
    this.sent.push(structuredClone(data, { transfer: transfer ?? [] }));
  }
  reply(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", ControlledWorker);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps memo bytes attached and only publishes the latest requested generation", () => {
  const onUrl = vi.fn();
  const onError = vi.fn();
  const reader = createPdfPreviewWorker(onUrl, onError);
  const worker = ControlledWorker.current;
  const first = new Uint8Array([1, 2]).buffer;
  reader.show(first);
  reader.show(new Uint8Array([3]).buffer);
  expect(worker.sent).toEqual([]);
  worker.reply({ type: "ready" });
  expect(worker.sent).toEqual([{ type: "show", generation: 2, bytes: new Uint8Array([3]).buffer }]);
  reader.show(first);
  worker.reply({ type: "shown", generation: 2, url: "blob:" + location.origin + "/old" });
  expect(onUrl).not.toHaveBeenCalled();
  worker.reply({ type: "shown", generation: 1, url: "blob:" + location.origin + "/stale" });
  expect(onUrl).not.toHaveBeenCalled();
  worker.reply({ type: "shown", generation: 3, url: "blob:" + location.origin + "/current" });
  expect(onUrl).toHaveBeenCalledExactlyOnceWith("blob:" + location.origin + "/current");
  expect(new Uint8Array(first)).toEqual(new Uint8Array([1, 2]));
  expect(onError).not.toHaveBeenCalled();
  reader.dispose();
  expect(worker.sent.at(-1)).toEqual({ type: "dispose" });
  expect(worker.terminate).not.toHaveBeenCalled();
  worker.reply({ type: "disposed" });
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["startup", "hung", "error", "messageerror", "invalid"] as const)(
  "retires a %s worker with a bounded fallback",
  (failure) => {
    const onUrl = vi.fn();
    const onError = vi.fn();
    const reader = createPdfPreviewWorker(onUrl, onError);
    const worker = ControlledWorker.current;
    reader.show(new ArrayBuffer(8));
    if (failure !== "startup") {
      worker.reply({ type: "ready" });
    }
    if (failure === "error") {
      worker.dispatchEvent(new Event("error"));
    } else if (failure === "messageerror") {
      worker.dispatchEvent(new Event("messageerror"));
    } else if (failure === "invalid") {
      worker.reply({ type: "shown", generation: 1, url: "https://untrusted.invalid/" });
    } else {
      vi.advanceTimersByTime(10_000);
    }
    expect(onError).toHaveBeenCalledOnce();
    expect(worker.sent.at(-1)).toEqual({ type: "dispose" });
    worker.reply({ type: "shown", generation: 1, url: "blob:" + location.origin + "/late" });
    expect(onUrl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);
