import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";

const importingScope = new AsyncLocalStorage<string>();
const { observeOwnedDirectory } = await runInDetachedAsyncContext(() =>
  importingScope.run("retired-importer", () => import("./owned-directory-observation.js")),
);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const subscriptions: Array<{ close(): void }> = [];
afterEach(() => {
  for (const subscription of subscriptions.splice(0)) {
    subscription.close();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("process-owned directory observation", () => {
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
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
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
    vi.advanceTimersByTime(30_000);
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

  it("re-admits an absent directory and invalidates after missed notifications", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const root = tempDirs.make("owned-directory-missing-");
    const directory = path.join(root, "new");
    const listener = vi.fn();
    subscriptions.push(observeOwnedDirectory(directory, listener));
    fs.mkdirSync(directory);
    vi.advanceTimersByTime(30_000);
    expect(listener).toHaveBeenCalledWith(undefined);
    listener.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(listener).toHaveBeenCalledWith(undefined);
  });
});
