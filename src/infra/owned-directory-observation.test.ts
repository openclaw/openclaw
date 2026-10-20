import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
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
// Select the adapter's overload so its registered event callback stays typed.
const nativeWatchFs: {
  watch(
    filename: fs.PathLike,
    options: fs.WatchOptionsWithStringEncoding,
    listener: fs.WatchListener<string>,
  ): fs.FSWatcher;
} = fs;
class SilentWatch extends EventEmitter implements fs.FSWatcher {
  close() {}
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
// Node builds Linux recursive watches from nested fs.watch calls, and Node 24 accepts
// a missing recursive root with a watch that never reports. Stub recursive handles
// that way on every runtime so the spy counts only the observer's registrations.
function spyOnNativeWatch() {
  const watch = fs.watch;
  return vi
    .spyOn(nativeWatchFs, "watch")
    .mockImplementation((filename, options, listener) =>
      options.recursive ? new SilentWatch() : watch(filename, options, listener),
    );
}
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
  it("bounds scheduling work as directories subscribe and close", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const root = tempDirs.make("owned-directory-fleet-");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const clock = vi.spyOn(Date, "now");
    const listener = vi.fn();
    for (let index = 0; index < 8; index++) {
      const directory = path.join(root, `agent-${index}`);
      fs.mkdirSync(directory);
      clock.mockClear();
      subscriptions.push(observeOwnedDirectory(directory, listener));
      expect(clock.mock.calls.length).toBeLessThanOrEqual(4);
    }
    expect(timeout).toHaveBeenCalledOnce();
    clock.mockClear();
    while (subscriptions.length > 1) {
      subscriptions.pop()!.close();
    }
    expect(clock).not.toHaveBeenCalled();
    expect(timeout).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30_000);
    expect(listener).toHaveBeenCalledOnce();
    subscriptions.pop()!.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers healthy watches every 30 seconds", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const directory = tempDirs.make("owned-directory-cadence-");
    const listener = vi.fn();
    subscriptions.push(observeOwnedDirectory(directory, listener));
    vi.advanceTimersByTime(29_999);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("keeps the authority recovery bound across a backward wall-clock correction", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(300_000);
    const directory = tempDirs.make("owned-directory-clock-");
    const listener = vi.fn();
    subscriptions.push(observeOwnedDirectory(directory, listener));
    vi.setSystemTime(0);
    vi.advanceTimersByTime(30_000);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("shares recursive watches while preserving each consumer's recovery interval", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const directory = tempDirs.make("owned-directory-recursive-");
    const watch = spyOnNativeWatch();
    const frequent = vi.fn();
    const quiet = vi.fn();
    subscriptions.push(observeOwnedDirectory(directory, frequent, { recursive: true }));
    subscriptions.push(
      observeOwnedDirectory(directory, quiet, {
        recursive: true,
        reconcileIntervalMs: 30 * 60_000,
      }),
    );
    expect(watch).toHaveBeenCalledOnce();
    expect(watch.mock.calls[0]![1]).toMatchObject({ recursive: true });
    vi.advanceTimersByTime(300_000);
    expect(frequent).toHaveBeenCalledTimes(10);
    expect(quiet).not.toHaveBeenCalled();
    watch.mock.calls[0]![2]("change", "nested/resource.txt");
    expect(quiet).toHaveBeenCalledWith("nested/resource.txt");
    quiet.mockClear();
    vi.advanceTimersByTime(25 * 60_000);
    expect(quiet).toHaveBeenCalledOnce();
  });

  it("keeps recursive handles outside replaceable subtrees and filters their events", () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const workspace = tempDirs.make("owned-directory-boundary-");
    const skills = path.join(workspace, "skills");
    const grouped = path.join(workspace, ".agents", "skills");
    fs.mkdirSync(skills);
    fs.mkdirSync(grouped, { recursive: true });
    const watch = spyOnNativeWatch();
    const changed = vi.fn();
    const groupedChanged = vi.fn();
    subscriptions.push(
      observeOwnedDirectory(skills, changed, { recursive: true, watchRoot: workspace }),
      observeOwnedDirectory(grouped, groupedChanged, { recursive: true, watchRoot: workspace }),
    );
    // Windows refuses an ancestor rename while a descendant directory handle is open.
    expect(watch).toHaveBeenCalledOnce();
    expect(watch.mock.calls[0]![0]).toBe(workspace);
    const onChange = watch.mock.calls[0]![2];
    onChange("change", path.join("skills", "guide", "SKILL.md"));
    expect(changed).toHaveBeenCalledOnce();
    expect(groupedChanged).not.toHaveBeenCalled();
    changed.mockClear();
    onChange("change", path.join("output", "report.md"));
    expect(changed).not.toHaveBeenCalled();
    expect(groupedChanged).not.toHaveBeenCalled();
    onChange("rename", ".agents");
    expect(groupedChanged).toHaveBeenCalledOnce();

    // Windows does not report a watched root moving. Replace it before the
    // safety pass and verify both subscribers leave the retired handle together.
    const close = vi.spyOn(watch.mock.results[0]!.value, "close");
    fs.renameSync(workspace, path.join(tempDirs.make("owned-directory-retired-"), "workspace"));
    fs.mkdirSync(skills, { recursive: true });
    fs.mkdirSync(grouped, { recursive: true });
    vi.advanceTimersByTime(30_000);
    expect(close).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledTimes(2);
    expect(watch.mock.calls[1]![0]).toBe(workspace);
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
    expect(listener).toHaveBeenCalledTimes(2);
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
    const watch = vi.spyOn(nativeWatchFs, "watch");
    const listener = vi.fn();
    subscriptions.push(observeOwnedDirectory(directory, listener));
    watch.mock.calls[0]![2]("rename", "profiles");
    expect(listener).toHaveBeenCalledWith("profiles");
    listener.mockClear();
    watch.mock.calls[0]![2]("change", path.basename(directory));
    expect(listener).toHaveBeenCalledWith(path.basename(directory));
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
    const watch = vi.spyOn(nativeWatchFs, "watch");
    const listener = vi.fn();
    subscriptions.push(observeOwnedDirectory(shortPath, listener));
    expect(watch).toHaveBeenCalledOnce();
    expect(watch.mock.calls[0]![0]).toBe(longPath);
    watch.mock.calls[0]![2]("change", "auth.json");
    expect(listener).toHaveBeenCalledWith("auth.json");
  });

  it("ignores ancestor activity while observing missing subtree creation and replacement", () => {
    const root = tempDirs.make("owned-directory-ancestor-");
    const agents = path.join(root, "agents");
    const watch = spyOnNativeWatch();
    const opened = () =>
      watch.mock.results.flatMap((result, index) =>
        result.type === "return"
          ? [
              {
                path: watch.mock.calls[index]?.[0],
                watcher: result.value,
                onChange: watch.mock.calls[index]![2],
              },
            ]
          : [],
      );
    const changed = vi.fn();
    subscriptions.push(
      observeOwnedDirectory(path.join(agents, "work"), changed, { recursive: true }),
    );
    const [ancestor] = opened();
    expect(ancestor?.path).toBe(root);
    const close = vi.spyOn(ancestor!.watcher, "close");
    // SQLite sidecars beside a state database appear and vanish on every write.
    ancestor!.onChange("rename", "state.sqlite-journal");
    // macOS also reports the parent's own metadata change for sibling writes.
    ancestor!.onChange("change", path.basename(root));
    expect(changed).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(opened()).toHaveLength(1);
    fs.mkdirSync(agents);
    ancestor!.onChange("rename", "agents");
    expect(changed).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(opened().map((entry) => entry.path)).toEqual([root, agents]);
    changed.mockClear();
    opened()[1]!.onChange("rename", "agents");
    expect(changed).toHaveBeenCalledOnce();
    expect(opened().map((entry) => entry.path)).toEqual([root, agents, agents]);
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
    expect(listener).toHaveBeenCalledWith(undefined);
  });
});
