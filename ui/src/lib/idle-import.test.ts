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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createIdleImport", () => {
  it("waits for the idle schedule before importing", async () => {
    idleImport.schedule();
    expect(importModule).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 3000 });
    await vi.runAllTimersAsync();
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledWith(loadedModule);
  });

  it.each([true, false])("retries a failed import (initially online: %s)", async (online) => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
    importModule.mockRejectedValueOnce(new Error("transient"));
    idleImport.schedule();
    await vi.runAllTimersAsync();
    if (!online) {
      expect(importModule).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event("online"));
      await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledWith(loadedModule));
    }
    expect(importModule).toHaveBeenCalledTimes(2);
    expect(onLoaded).toHaveBeenCalledWith(loadedModule);
  });

  it("removes its online retry listener when disposed", async () => {
    importModule.mockRejectedValue(new Error("offline"));
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    idleImport = createIdleImport(importModule);

    await expect(idleImport.load()).rejects.toThrow("offline");
    idleImport.dispose();
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();

    expect(removeEventListener.mock.calls).toContainEqual(
      expect.arrayContaining(["online", expect.any(Function)]),
    );
    expect(importModule).toHaveBeenCalledTimes(1);
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
