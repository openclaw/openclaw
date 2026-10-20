/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleImport } from "./idle-import.ts";

const importModule = vi.fn<() => Promise<string>>();
const onLoaded = vi.fn();
let idleImport: ReturnType<typeof createIdleImport<string>>;
beforeEach(() => {
  importModule.mockReset().mockResolvedValue("loaded");
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
    expect(onLoaded).toHaveBeenCalledWith("loaded");
  });

  it("clears a failed import and re-arms it when the browser comes online", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    importModule.mockRejectedValueOnce(new Error("offline"));
    idleImport.schedule();
    await vi.runAllTimersAsync();

    expect(importModule).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledWith("loaded"));

    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("retries one failed import while the browser remains online", async () => {
    importModule.mockRejectedValueOnce(new Error("transient"));
    idleImport.schedule();
    await vi.runAllTimersAsync();

    expect(importModule).toHaveBeenCalledTimes(2);
    expect(onLoaded).toHaveBeenCalledWith("loaded");
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
    const module = { ready: true };
    const importObject = vi.fn(async () => module);
    const objectLoaded = vi.fn();
    const objectImport = createIdleImport(importObject, objectLoaded);
    const first = objectImport.load();
    const second = objectImport.load();
    await expect(first).resolves.toBe(module);
    await expect(second).resolves.toBe(module);
    await expect(objectImport.load()).resolves.toBe(module);
    expect(importObject).toHaveBeenCalledTimes(1);
    expect(objectLoaded).toHaveBeenCalledTimes(1);
  });
});
