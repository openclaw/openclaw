import fs from "node:fs";
import path from "node:path";
import { FSWatcher } from "chokidar";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createNativeSkillsAncestorWatcher } from "./refresh-ancestor-native.js";
import { joinSkillsWatcherCloses, teardownSkillsPathWatcher } from "./refresh-watch-close.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("keeps retirement terminal while a replacement watcher admits the root", async () => {
  const root = roots.make("skills-retired-watcher-");
  const retired = new FSWatcher({ ignoreInitial: true });
  const replacement = new FSWatcher({ ignoreInitial: true });
  try {
    await teardownSkillsPathWatcher({ watcher: retired });
    // Removed-directory recovery resumes through this same public admission path.
    retired.add(root);
    expect(retired.closed).toBe(true);

    const ready = new Promise<void>((resolve, reject) => {
      replacement.once("ready", resolve);
      replacement.once("error", reject);
    });
    replacement.add(root);
    await ready;
    expect(replacement.closed).toBe(false);
    expect(Object.keys(replacement.getWatched())).toContain(root);
  } finally {
    await Promise.all([retired.close(), replacement.close()]);
  }
});

it
  .runIf(process.platform === "linux" && !process.versions.bun)
  .each(["registration", "native-error"] as const)(
  "joins native ancestor closure after %s fails without a close event",
  async (failure) => {
    const root = roots.make("skills-native-close-");
    const watch = vi.spyOn(fs, "watch");
    const watchedPath = failure === "registration" ? path.join(root, "missing") : root;
    const watcher = createNativeSkillsAncestorWatcher(
      watchedPath,
      () => false,
      () => {},
    );
    const errors: unknown[] = [];
    const ready = vi.fn();
    watcher.on("error", (error) => errors.push(error));
    watcher.on("ready", ready);
    const result = watch.mock.results[0];
    const native = result?.type === "return" ? result.value : undefined;
    const closeListeners = native?.rawListeners("close") ?? [];
    try {
      if (failure === "native-error") {
        expect(native).toBeDefined();
        // Match Node's native error contract: release the handle, report error,
        // and omit close. Preserve callbacks for unconditional fixture recovery.
        native!.removeAllListeners("close");
        native!.close();
        native!.emit("error", Object.assign(new Error("native watch failed"), { code: "EIO" }));
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(errors).toHaveLength(1);
      expect(ready).not.toHaveBeenCalled();
      let joined = false;
      const closing = watcher.close();
      void joinSkillsWatcherCloses().then(() => {
        joined = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(joined).toBe(true);
      await closing;
    } finally {
      if (native) {
        for (const listener of closeListeners) {
          native.on("close", listener);
        }
        native.close();
        native.emit("close");
      }
      await watcher.close();
      await joinSkillsWatcherCloses();
      watch.mockRestore();
    }
  },
);
