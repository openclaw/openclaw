import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";

const importingScope = new AsyncLocalStorage<string>();
const { observeOwnedDirectory } = await runInDetachedAsyncContext(() =>
  importingScope.run("retired-importer", () => import("./owned-directory-observation.js")),
);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// These cases drive in-process watchers; directory-watch-host.test.ts covers the macOS host.
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
});
const subscriptions: Array<{ close(): void }> = [];
afterEach(() => {
  for (const subscription of subscriptions.splice(0)) {
    subscription.close();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", platform);
});

describe("process-owned directory observation", () => {
  it("bounds scheduling work while 810 directories subscribe and close", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const root = tempDirs.make("owned-directory-fleet-");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const clock = vi.spyOn(Date, "now");
    const listener = vi.fn();
    for (let index = 0; index < 810; index++) {
      const directory = path.join(root, `agent-${index}`);
      fs.mkdirSync(directory);
      clock.mockClear();
      subscriptions.push(observeOwnedDirectory(directory, listener));
      expect(clock.mock.calls.length).toBeLessThanOrEqual(4);
    }
    expect(timeout).toHaveBeenCalledOnce();
    clock.mockClear();
    for (let index = 0; index < 809; index++) {
      subscriptions.pop()!.close();
    }
    expect(clock).not.toHaveBeenCalled();
    expect(timeout).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(300_000);
    expect(listener).toHaveBeenCalledOnce();
    subscriptions.pop()!.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers healthy watches every five minutes while authority subscribers keep 30 seconds", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const directory = tempDirs.make("owned-directory-cadence-");
    const listener = vi.fn();
    subscriptions.push(observeOwnedDirectory(directory, listener));
    vi.advanceTimersByTime(299_999);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledOnce();
    const authority = vi.fn();
    subscriptions.push(observeOwnedDirectory(directory, authority, { recoveryIntervalMs: 30_000 }));
    vi.advanceTimersByTime(30_000);
    expect(authority).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the authority recovery bound across a backward wall-clock correction", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(300_000);
    const directory = tempDirs.make("owned-directory-clock-");
    const listener = vi.fn();
    subscriptions.push(observeOwnedDirectory(directory, listener, { recoveryIntervalMs: 30_000 }));
    vi.setSystemTime(0);
    vi.advanceTimersByTime(30_000);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("repairs failed watches within 30 seconds and resumes healthy recovery", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const directory = tempDirs.make("owned-directory-repair-");
    const watch = vi.spyOn(fs, "watch");
    const listener = vi.fn();
    subscriptions.push(observeOwnedDirectory(directory, listener));
    watch.mock.results[0]!.value.emit("error", new Error("lost watch"));
    listener.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(listener).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("creates long-lived observations outside importer and caller authority", () => {
    const directory = tempDirs.make("owned-directory-authority-");
    const watch = fs.watch;
    const scopes: Array<string | undefined> = [];
    vi.spyOn(fs, "watch").mockImplementation((...args: Parameters<typeof watch>) => {
      scopes.push(importingScope.getStore());
      return watch(...args);
    });
    importingScope.run("retired-caller", () => {
      subscriptions.push(observeOwnedDirectory(directory, () => {}));
    });
    expect(scopes).toEqual([undefined]);
  });

  it("shares one watcher and reconciles a separate process's atomic replacement", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const directory = tempDirs.make("owned-directory-external-");
    const filename = path.join(directory, "profiles");
    fs.writeFileSync(filename, "before");
    const watch = vi.spyOn(fs, "watch");
    const listener = vi.fn(() => fs.readFileSync(filename, "utf8"));
    const otherListener = vi.fn();
    subscriptions.push(observeOwnedDirectory(directory, listener));
    subscriptions.push(observeOwnedDirectory(directory, otherListener));
    expect(watch).toHaveBeenCalledTimes(1);
    await promisify(execFile)(process.execPath, [
      "-e",
      "const fs = require('node:fs'); const p = process.argv[1]; fs.writeFileSync(p + '.tmp', 'after'); fs.renameSync(p + '.tmp', p);",
      filename,
    ]);
    vi.advanceTimersByTime(300_000);
    expect(listener).toHaveLastReturnedWith("after");
    expect(otherListener).toHaveBeenCalledWith(undefined);
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("forwards native file invalidation without replacing the shared directory watch", () => {
    const directory = tempDirs.make("owned-directory-events-");
    const watch = vi.spyOn(fs, "watch");
    const listener = vi.fn();
    subscriptions.push(observeOwnedDirectory(directory, listener));
    const result = watch.mock.results[0];
    if (result?.type !== "return") {
      throw new Error("Missing native directory watcher");
    }
    result.value.emit("change", "rename", "profiles");
    expect(listener).toHaveBeenCalledWith("profiles");
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("watches the long form of a Windows 8.3 short path", () => {
    // libuv aborts when a directory watch opened through a short path reports a child event.
    const root = tempDirs.make("owned-directory-short-");
    const shortPath = path.join(root, "RUNNER~1");
    const longPath = path.join(root, "runneradmin");
    fs.mkdirSync(shortPath);
    fs.mkdirSync(longPath);
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs.realpathSync, "native").mockImplementation(((target: fs.PathLike) =>
      target === shortPath ? longPath : String(target)) as typeof fs.realpathSync.native);
    const watch = vi.spyOn(fs, "watch");
    const listener = vi.fn();
    subscriptions.push(observeOwnedDirectory(shortPath, listener));
    expect(watch).toHaveBeenCalledOnce();
    expect(watch.mock.calls[0]![0]).toBe(longPath);
    const result = watch.mock.results[0];
    if (result?.type !== "return") {
      throw new Error("Missing native directory watcher");
    }
    result.value.emit("change", "change", "auth.json");
    expect(listener).toHaveBeenCalledWith("auth.json");
  });

  it("keeps an absent directory's ancestor watch across unrelated child renames", () => {
    const root = tempDirs.make("owned-directory-ancestor-");
    const agents = path.join(root, "agents");
    const watch = vi.spyOn(fs, "watch");
    const opened = () =>
      watch.mock.results.flatMap((result, index) =>
        result.type === "return"
          ? [{ path: watch.mock.calls[index]?.[0], watcher: result.value }]
          : [],
      );
    subscriptions.push(observeOwnedDirectory(path.join(agents, "work"), () => {}));
    const [ancestor] = opened();
    expect(ancestor?.path).toBe(root);
    const close = vi.spyOn(ancestor!.watcher, "close");
    // SQLite sidecars beside a state database appear and vanish on every write.
    ancestor!.watcher.emit("change", "rename", "state.sqlite-journal");
    expect(close).not.toHaveBeenCalled();
    expect(opened()).toHaveLength(1);
    fs.mkdirSync(agents);
    ancestor!.watcher.emit("change", "rename", "agents");
    expect(close).toHaveBeenCalledOnce();
    expect(opened().map((entry) => entry.path)).toEqual([root, agents]);
  });

  it("re-admits an absent directory and invalidates after missed notifications", () => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(0);
    const root = tempDirs.make("owned-directory-missing-");
    const directory = path.join(root, "new");
    const listener = vi.fn();
    subscriptions.push(observeOwnedDirectory(directory, listener));
    fs.mkdirSync(directory);
    vi.advanceTimersByTime(30_000);
    expect(listener).toHaveBeenCalledWith(undefined);
    listener.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(270_000);
    expect(listener).toHaveBeenCalledWith(undefined);
  });
});
