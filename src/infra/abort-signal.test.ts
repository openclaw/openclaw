import { describe, expect, it, vi } from "vitest";
import { waitForAbortSignal } from "./abort-signal.js";

describe("waitForAbortSignal", () => {
  it("returns immediately for undefined signal", async () => {
    const start = Date.now();
    await waitForAbortSignal(undefined);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("returns immediately for already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await waitForAbortSignal(controller.signal);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("waits for abort when not aborted", async () => {
    const controller = new AbortController();
    const promise = waitForAbortSignal(controller.signal);
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    await promise;
    expect(controller.signal.aborted).toBe(true);
  });

  it("can be called multiple times", async () => {
    const controller = new AbortController();
    controller.abort();
    await waitForAbortSignal(controller.signal);
    await waitForAbortSignal(controller.signal);
    expect(true).toBe(true);
  });
});
