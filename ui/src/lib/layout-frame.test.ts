/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { scheduleLayout } from "./layout-frame.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("runs every owner's layout work when another owner throws in the same frame", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  const reportError = vi.fn();
  vi.stubGlobal("reportError", reportError);
  const readFailure = new Error("read failed");
  const writeFailure = new Error("write failed");
  const writes: string[] = [];

  scheduleLayout({}, () => {
    throw readFailure;
  });
  scheduleLayout({}, () => () => {
    throw writeFailure;
  });
  scheduleLayout({}, () => () => writes.push("reveal"));
  frames.splice(0).forEach((callback) => callback(0));

  expect(writes).toEqual(["reveal"]);
  expect(reportError.mock.calls).toEqual([[readFailure], [writeFailure]]);
});
