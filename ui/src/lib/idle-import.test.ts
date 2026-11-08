/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleImport } from "./idle-import.ts";

const loadedModule = { ready: true };
const importModule = vi.fn<() => Promise<typeof loadedModule>>();
const onLoaded = vi.fn();
let idleImport: ReturnType<typeof createIdleImport<typeof loadedModule>>;
beforeEach(() => {
  importModule.mockReset().mockResolvedValue(loadedModule);
  onLoaded.mockReset();
  idleImport = createIdleImport(importModule, onLoaded);
  vi.useFakeTimers();
  vi.stubGlobal(
    "requestIdleCallback",
    vi.fn((callback: IdleRequestCallback) =>
      window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0),
    ),
  );
});

afterEach(() => {
  idleImport.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createIdleImport", () => {
  it.each([false, true])(
    "waits out an import outage without retrying a disposed owner (%s)",
    async (dispose) => {
      const probe = vi.fn().mockRejectedValue(new TypeError("offline"));
      vi.stubGlobal("fetch", probe);
      importModule.mockRejectedValueOnce(
        new TypeError("Failed to fetch dynamically imported module"),
      );
      idleImport.schedule();
      await vi.advanceTimersByTimeAsync(500);
      await vi.dynamicImportSettled();
      expect(importModule).toHaveBeenCalledOnce();
      expect(onLoaded).not.toHaveBeenCalled();
      if (dispose) {
        idleImport.dispose();
      }
      probe.mockResolvedValue(new Response(null, { status: 200 }));
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.dynamicImportSettled();
      expect(importModule).toHaveBeenCalledTimes(dispose ? 1 : 2);
      expect(onLoaded).toHaveBeenCalledTimes(dispose ? 0 : 1);
    },
  );

  it("waits for the idle schedule before importing", async () => {
    idleImport.schedule();
    expect(importModule).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 3000 });
    await vi.runAllTimersAsync();
    await vi.dynamicImportSettled();
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledWith(loadedModule);
  });

  it("resumes its pending import when reactivated during an outage", async () => {
    const probe = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", probe);
    importModule.mockRejectedValueOnce(
      new TypeError("Failed to fetch dynamically imported module"),
    );
    idleImport.schedule();
    await vi.advanceTimersByTimeAsync(0);
    await vi.dynamicImportSettled();
    expect(importModule).toHaveBeenCalledOnce();
    idleImport.dispose();
    idleImport.schedule();
    probe.mockResolvedValue(new Response(null, { status: 200 }));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.dynamicImportSettled();
    expect(importModule).toHaveBeenCalledTimes(2);
    expect(onLoaded).toHaveBeenCalledExactlyOnceWith(loadedModule);
  });

  it("shares and retains a successful module promise", async () => {
    const first = idleImport.load();
    const second = idleImport.load();
    await expect(first).resolves.toBe(loadedModule);
    await expect(second).resolves.toBe(loadedModule);
    await expect(idleImport.load()).resolves.toBe(loadedModule);
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });
});
