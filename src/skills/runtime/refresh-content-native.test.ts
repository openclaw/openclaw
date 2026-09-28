import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createNativeSkillsContentWatcher } from "./refresh-content-native.js";
import { createSkillsWatchPathFilter, resolveRawSkillsWatchPath } from "./refresh-watch-path.js";
import { shouldUseNativeSkillsWatcher } from "./refresh-watch-transport.js";
import type { SkillsDirectoryWatcher } from "./refresh-watch-types.js";
import { deliverWindowsNotification, ready } from "./refresh.native.test-support.js";

const useNative = shouldUseNativeSkillsWatcher(false);
describe.runIf(useNative)("Skills Node native directory ownership", () => {
  let root: string;
  const watchers: SkillsDirectoryWatcher[] = [];
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-native-owner-")));
  });
  afterEach(async () => {
    await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });
  const watch = (directory: string, depth = 3) => {
    const watcher = createNativeSkillsContentWatcher(directory.replaceAll("\\", "/"), {
      depth,
      ignored: createSkillsWatchPathFilter(directory, false).ignored,
    });
    watchers.push(watcher);
    return watcher;
  };

  it("owns the native registration before a held directory read and joins that read on close", async () => {
    const child = path.join(root, "child");
    await fs.mkdir(child);
    const release = createDeferredCore();
    let readEntered = false;
    const handles: Array<{ directory: string; closed: boolean }> = [];
    const originalWatch = nativeFs.watch;
    vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
      const native = originalWatch(...args);
      const observation = { directory: path.resolve(String(args[0])), closed: false };
      handles.push(observation);
      native.once("close", () => {
        observation.closed = true;
      });
      return native;
    });
    const originalRead = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === child) {
        readEntered = true;
        await release.promise;
      }
      return originalRead(...args);
    });
    const watcher = watch(root);
    const errors: unknown[] = [];
    watcher.on("error", (error) => errors.push(error));
    try {
      await vi.waitFor(() => expect(readEntered).toBe(true));
      expect(handles.map(({ directory }) => directory).toSorted()).toEqual(
        [root, child].toSorted(),
      );
      let settled = false;
      const closing = watcher.close().then((result) => {
        settled = true;
        return result;
      });
      await vi.waitFor(() => expect(handles.every(({ closed }) => closed)).toBe(true));
      expect(settled).toBe(false);
      await fs.mkdir(path.join(child, "late"));
      release.resolve();
      expect(await closing).toEqual({ ok: true, value: undefined });
      expect(handles).toHaveLength(2);
      expect(errors).toEqual([]);
      expect(watcher.directories.size).toBe(0);
    } finally {
      release.resolve();
      await watcher.close();
    }
  });

  it("does not acquire a handle when closed before its startup microtask", async () => {
    const acquire = vi.spyOn(nativeFs, "watch");
    const watcher = watch(root);
    const closing = watcher.close();
    expect(watcher.close()).toBe(closing);
    expect(await closing).toEqual({ ok: true, value: undefined });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("retains healthy coverage when a vanished child rejects a directory listing", async () => {
    const directory = path.join(root, "skills");
    const child = path.join(directory, "a-child");
    const deep = path.join(child, "deep");
    const sibling = path.join(directory, "z-sibling");
    const vanished = path.join(child, "vanished");
    const deepFile = path.join(deep, "SKILL.md");
    const siblingFile = path.join(sibling, "SKILL.md");
    await fs.mkdir(deep, { recursive: true });
    await fs.mkdir(sibling);
    for (const file of [vanished, deepFile, siblingFile]) {
      await fs.writeFile(file, "before");
    }
    const identity = nativeFs.statSync(child, { bigint: true });
    const releaseSibling = createDeferredCore();
    let armed = false;
    let incomplete = false;
    let siblingHeld = false;
    let deepListed = false;
    let listingFailure: unknown;
    const readdir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      const current = path.resolve(String(args[0]));
      const children = await readdir(...args);
      if (current === directory) {
        children.sort((left, right) => String(left.name).localeCompare(String(right.name)));
      }
      if (armed && current === child && !incomplete) {
        incomplete = true;
        await fs.unlink(vanished);
        try {
          // Node's UNKNOWN Dirent conversion forwards this child lstat error.
          // The listed directory and its existing descendants remain healthy.
          await fs.lstat(vanished);
        } catch (error) {
          listingFailure = error;
          throw error;
        }
        throw new Error("Expected the removed child lstat to fail");
      }
      if (armed && current === sibling && !siblingHeld) {
        siblingHeld = true;
        await releaseSibling.promise;
      }
      if (armed && current === deep) {
        deepListed = true;
      }
      return children;
    });
    let deliverEvents = false;
    const handles: Array<{
      directory: string;
      closed: boolean;
      deliver: (event: nativeFs.WatchEventType, filename: string | null) => void;
    }> = [];
    const nativeWatch = nativeFs.watch;
    vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
      const deliver = args[1];
      if (typeof deliver !== "function") {
        throw new Error("Expected a shallow native callback");
      }
      const native = nativeWatch(args[0], (event, filename) => {
        if (deliverEvents) {
          deliver(event, filename);
        }
      });
      const observed = { directory: path.resolve(String(args[0])), closed: false, deliver };
      handles.push(observed);
      native.once("close", () => {
        observed.closed = true;
      });
      return native;
    });
    const watcher = watch(directory);
    const errors: unknown[] = [];
    const events = vi.fn();
    watcher.on("error", (error) => errors.push(error));
    watcher.on("all", events);
    try {
      await ready(watcher);
      expect(handles).toHaveLength(4);
      armed = true;
      handles.find((handle) => handle.directory === directory)!.deliver("rename", "a-child");
      // Both paths reach this checkpoint: the old scan after retiring a-child,
      // the corrected scan after retrying its incomplete listing under custody.
      await vi.waitFor(() => expect(siblingHeld).toBe(true));
      expect(listingFailure).toMatchObject({ code: "ENOENT", syscall: "lstat", path: vanished });
      const current = nativeFs.statSync(child, { bigint: true });
      expect([current.dev, current.ino]).toEqual([identity.dev, identity.ino]);
      expect(errors).toEqual([]);
      expect(watcher.directories.size).toBe(4);
      expect(handles).toHaveLength(4);
      expect(handles.every(({ closed }) => !closed)).toBe(true);
      expect(events).not.toHaveBeenCalled();
      releaseSibling.resolve();
      await vi.waitFor(() => expect(deepListed).toBe(true));
      const normalize = (value: string) => value.replaceAll("\\", "/");
      expect([...watcher.directories].toSorted()).toEqual(
        [directory, child, deep, sibling].map(normalize).toSorted(),
      );
      const changed = new Set<string>();
      watcher.on("raw", (_event, filename, details) => {
        if (typeof filename === "string") {
          const changedPath = resolveRawSkillsWatchPath(filename, details);
          if (changedPath) {
            changed.add(normalize(changedPath));
          }
        }
      });
      deliverEvents = true;
      await fs.writeFile(deepFile, "later deep edit");
      await fs.writeFile(siblingFile, "later sibling edit");
      await vi.waitFor(() => {
        expect(changed.has(normalize(deepFile))).toBe(true);
        expect(changed.has(normalize(siblingFile))).toBe(true);
      });
    } finally {
      releaseSibling.resolve();
      expect(await watcher.close()).toEqual({ ok: true, value: undefined });
      expect(handles.every(({ closed }) => closed)).toBe(true);
      expect(errors).toEqual([]);
    }
  });

  it.each([
    { retireRead: false, dirtyRead: false, code: "EACCES" },
    { retireRead: true, dirtyRead: false, code: "EACCES" },
    { retireRead: false, dirtyRead: true, code: "EACCES" },
    { retireRead: false, dirtyRead: true, code: "EIO" },
  ])(
    "handles a pending $code read failure with its registration retired=$retireRead dirty=$dirtyRead",
    async ({ retireRead, dirtyRead, code }) => {
      const child = path.join(root, "child");
      const sibling = path.join(root, "sibling");
      const deep = path.join(child, "deep");
      const file = path.join(deep, "SKILL.md");
      await fs.mkdir(child);
      await fs.mkdir(sibling);
      const release = createDeferredCore();
      const failure = Object.assign(new Error("admitted directory read failed"), { code });
      const readdir = fs.readdir;
      let held = false;
      vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (path.resolve(String(args[0])) === child && !held) {
          held = true;
          await release.promise;
          throw failure;
        }
        return readdir(...args);
      });
      const handles: Array<{
        directory: string;
        closed: boolean;
        deliver: (event: nativeFs.WatchEventType, filename: string | null) => void;
      }> = [];
      const nativeWatch = nativeFs.watch;
      vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
        const native = nativeWatch(...args);
        const deliver = args[1];
        if (typeof deliver !== "function") {
          throw new Error("Expected a shallow native callback");
        }
        const observed = { directory: path.resolve(String(args[0])), closed: false, deliver };
        handles.push(observed);
        native.once("close", () => {
          observed.closed = true;
        });
        return native;
      });
      const watcher = watch(root);
      const errors: unknown[] = [];
      const initialized = vi.fn();
      watcher.on("error", (error) => errors.push(error));
      watcher.on("ready", initialized);
      try {
        await vi.waitFor(() => expect(held).toBe(true));
        const admitted = handles.find(({ directory }) => directory === child)!;
        expect(admitted.closed).toBe(false);
        if (retireRead) {
          nativeFs.renameSync(child, path.join(root, "retired-child"));
          nativeFs.mkdirSync(child);
          admitted.deliver("rename", path.basename(child));
          await vi.waitFor(() => expect(admitted.closed).toBe(true));
        } else if (dirtyRead) {
          nativeFs.mkdirSync(path.join(root, "new-sibling"));
          const parent = handles.find(({ directory }) => directory === root)!;
          deliverWindowsNotification(() => parent.deliver("rename", "new-sibling"));
          expect(admitted.closed).toBe(false);
          expect(watcher.directories.has(child.replaceAll("\\", "/"))).toBe(true);
        }
        release.resolve();
        if (retireRead) {
          await vi.waitFor(() => expect(initialized).toHaveBeenCalledOnce());
          const normalize = (value: string) => value.replaceAll("\\", "/");
          expect(watcher.directories.has(normalize(sibling))).toBe(true);
          expect(watcher.directories.has(normalize(child))).toBe(true);
          nativeFs.mkdirSync(deep);
          nativeFs.writeFileSync(file, "replacement");
          await vi.waitFor(() => expect(watcher.directories.has(normalize(deep))).toBe(true));
          let changed = false;
          watcher.on("raw", (_event, filename, details) => {
            if (
              typeof filename === "string" &&
              resolveRawSkillsWatchPath(filename, details)?.replaceAll("\\", "/") ===
                normalize(file)
            ) {
              changed = true;
            }
          });
          await fs.writeFile(file, "later deep edit");
          await vi.waitFor(() => expect(changed).toBe(true));
          expect(errors).toEqual([]);
        } else {
          await vi.waitFor(() => expect(errors).toEqual([failure]));
          expect(initialized).not.toHaveBeenCalled();
        }
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
      } finally {
        release.resolve();
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
      }
    },
  );

  it.each([
    { invalidation: "retired", branch: "queued directory" },
    { invalidation: "retired", branch: "link-only" },
    { invalidation: "dirty", branch: "queued directory" },
    { invalidation: "dirty", branch: "link-only" },
  ] as const)(
    "discards a $invalidation $branch branch while a sibling listing is held",
    async ({ invalidation, branch }) => {
      const directory = path.join(root, "skills");
      const parent = path.join(directory, "a-parent");
      const sibling = path.join(directory, "b-sibling");
      const deep = path.join(parent, "deep");
      const link = path.join(parent, "link");
      const outside = path.join(root, "outside");
      const oldTarget = path.join(root, "old-target");
      const nextTarget = path.join(root, "next-target");
      for (const entry of [parent, sibling, path.join(outside, "deep"), oldTarget, nextTarget]) {
        await fs.mkdir(entry, { recursive: true });
      }
      const linkType = process.platform === "win32" ? "junction" : "dir";
      if (branch === "link-only") {
        await fs.symlink(oldTarget, link, linkType);
      }
      const releaseSibling = createDeferredCore();
      const releaseRetry = createDeferredCore();
      let armed = false;
      let siblingHeld = false;
      let retryHeld = false;
      let invalidated = false;
      const readdir = fs.readdir;
      const read = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        const current = path.resolve(String(args[0]));
        const children = await readdir(...args);
        if (current === directory) {
          children.sort((left, right) => String(left.name).localeCompare(String(right.name)));
          // Windows can rescan the first notification before branch invalidation.
          if (invalidated && !retryHeld) {
            retryHeld = true;
            await releaseRetry.promise;
          }
        }
        if (armed && current === sibling && !siblingHeld) {
          siblingHeld = true;
          await releaseSibling.promise;
        }
        return children;
      });
      let deliverEvents = false;
      const handles: Array<{
        directory: string;
        closed: boolean;
        deliver: (event: nativeFs.WatchEventType, filename: string | null) => void;
      }> = [];
      const nativeWatch = nativeFs.watch;
      vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
        const deliver = args[1];
        if (typeof deliver !== "function") {
          throw new Error("Expected a shallow native callback");
        }
        const native = nativeWatch(args[0], (event, filename) => {
          if (deliverEvents) {
            deliver(event, filename);
          }
        });
        const observed = { directory: path.resolve(String(args[0])), closed: false, deliver };
        handles.push(observed);
        native.once("close", () => {
          observed.closed = true;
        });
        return native;
      });
      const deepProbes = new Set<string>();
      const lstat = nativeFs.lstatSync;
      vi.spyOn(nativeFs, "lstatSync").mockImplementation((...args) => {
        const candidate = path.resolve(String(args[0]));
        if (candidate === deep) {
          deepProbes.add(candidate);
        }
        return lstat(...args);
      });
      const watcher = watch(directory);
      const errors: unknown[] = [];
      const events = vi.fn();
      watcher.on("error", (error) => errors.push(error));
      watcher.on("all", events);
      try {
        await ready(watcher);
        if (branch === "queued directory") {
          nativeFs.mkdirSync(deep);
        } else {
          nativeFs.unlinkSync(link);
          nativeFs.symlinkSync(nextTarget, link, linkType);
        }
        armed = true;
        handles.find((handle) => handle.directory === directory)!.deliver("rename", "a-parent");
        await vi.waitFor(() => expect(siblingHeld).toBe(true));
        const retired = handles.find((handle) => handle.directory === parent)!;
        expect(retired.closed).toBe(false);
        expect(handles.some((handle) => handle.directory === deep)).toBe(false);
        nativeFs.renameSync(parent, path.join(root, "retired-parent"));
        nativeFs.symlinkSync(outside, parent, linkType);
        invalidated = true;
        if (invalidation === "retired") {
          retired.deliver("rename", path.basename(parent));
          await vi.waitFor(() => expect(retired.closed).toBe(true));
        } else {
          // Windows need not report a moved directory to its own observer.
          // Only the enclosing owner dirties this scan; the parent stays owned.
          const enclosing = handles.find((handle) => handle.directory === directory)!;
          deliverWindowsNotification(() => enclosing.deliver("rename", path.basename(parent)));
          expect(retired.closed).toBe(false);
          expect(watcher.directories.has(parent.replaceAll("\\", "/"))).toBe(true);
        }
        events.mockClear();
        releaseSibling.resolve();
        // Hold the fresh scan before it can mask stale publication by the old
        // one. A link-only branch has no queued descendant to trip that fence.
        await vi.waitFor(() => expect(retryHeld).toBe(true));
        expect(deepProbes.size).toBe(0);
        expect(events).not.toHaveBeenCalled();
        expect(read.mock.calls.some(([entry]) => path.resolve(String(entry)) === deep)).toBe(false);
        expect(handles.some((handle) => handle.directory === deep)).toBe(false);
        expect(handles.some((handle) => handle.directory.startsWith(outside))).toBe(false);
        releaseRetry.resolve();
        await vi.waitFor(() =>
          expect(events).toHaveBeenCalledWith("add", parent.replaceAll("\\", "/")),
        );
        expect(watcher.directories.has(sibling.replaceAll("\\", "/"))).toBe(true);
        expect(watcher.directories.has(parent.replaceAll("\\", "/"))).toBe(false);
        deliverEvents = true;
        const file = path.join(sibling, "SKILL.md");
        let changed = false;
        watcher.on("raw", (_event, filename, details) => {
          if (
            typeof filename === "string" &&
            resolveRawSkillsWatchPath(filename, details)?.replaceAll("\\", "/") ===
              file.replaceAll("\\", "/")
          ) {
            changed = true;
          }
        });
        await fs.writeFile(file, "healthy sibling edit");
        await vi.waitFor(() => expect(changed).toBe(true));
        expect(errors).toEqual([]);
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
      } finally {
        releaseSibling.resolve();
        releaseRetry.resolve();
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
      }
    },
  );

  it("does not certify parent observation when the requested inode disappears and returns during admission", async () => {
    const directory = path.join(root, "skills");
    const moved = path.join(root, "moved");
    await fs.mkdir(directory);
    const inode = (await fs.stat(directory)).ino;
    const originalStat = nativeFs.lstatSync;
    let reads = 0;
    const stat = vi.spyOn(nativeFs, "lstatSync").mockImplementation((...args) => {
      if (path.resolve(String(args[0])) === directory && ++reads === 3) {
        // The content owner already captured its identity. Restore before a
        // fallback parent could be watched, so no parent event is owed.
        nativeFs.renameSync(directory, moved);
        try {
          return originalStat(...args);
        } finally {
          nativeFs.renameSync(moved, directory);
        }
      }
      return originalStat(...args);
    });
    const acquire = vi.spyOn(nativeFs, "watch");
    const watcher = watch(directory);
    const errors: unknown[] = [];
    const observedReady = vi.fn();
    watcher.on("error", (error) => errors.push(error));
    watcher.on("ready", observedReady);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ code: "ENOENT" });
    expect(observedReady).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect((await fs.stat(directory)).ino).toBe(inode);
    expect(await watcher.close()).toEqual({ ok: true, value: undefined });
    stat.mockRestore();

    // A later explicit acquisition can verify this now-stable directory.
    const replacement = watch(directory);
    await ready(replacement);
    expect(acquire).toHaveBeenCalledOnce();
    expect(replacement.directories.has(directory.replaceAll("\\", "/"))).toBe(true);
  });

  it("retains a failed first close after the original native handle is explicitly rescued", async () => {
    let native: nativeFs.FSWatcher | undefined;
    const originalWatch = nativeFs.watch;
    vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
      native = originalWatch(...args);
      return native;
    });
    const watcher = watch(root);
    await ready(watcher);
    expect(native).toBeDefined();
    const failure = new Error("native closer failed");
    const originalClose = native!.close.bind(native);
    const retired = createDeferredCore();
    native!.once("close", () => retired.resolve());
    vi.spyOn(native!, "close").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      const closing = watcher.close();
      expect(await closing).toEqual({ ok: false, error: failure });
      originalClose();
      await retired.promise;
      native!.emit("error", Object.assign(new Error("late native retirement"), { code: "EPERM" }));
      expect(watcher.close()).toBe(closing);
      expect(await watcher.close()).toEqual({ ok: false, error: failure });
    } finally {
      originalClose();
      await retired.promise;
    }
  });

  it.each(["missing", "file", "symlink", "replacement directory", "replacement ABA"] as const)(
    "keeps initial coverage when a child becomes %s during native admission",
    async (replacement) => {
      const directory = path.join(root, "skills");
      const child = path.join(directory, "child");
      const sibling = path.join(directory, "sibling");
      const target = path.join(root, "outside");
      const deep = path.join(child, "deep");
      const file = path.join(deep, "SKILL.md");
      await fs.mkdir(child, { recursive: true });
      await fs.mkdir(sibling);
      await fs.mkdir(target);
      const lstat = nativeFs.lstatSync;
      let replaced = false;
      let originalChild: nativeFs.BigIntStats | undefined;
      const retiredChild = path.join(root, "retired-child");
      vi.spyOn(nativeFs, "lstatSync").mockImplementation((...args) => {
        const identity = lstat(...args);
        if (
          path.resolve(String(args[0])) === child &&
          !replaced &&
          replacement !== "replacement directory"
        ) {
          expect(identity?.isDirectory()).toBe(true);
          // Return real scan facts, then change the entry before native admission.
          replaced = true;
          if (replacement === "replacement ABA") {
            originalChild = identity as nativeFs.BigIntStats;
            nativeFs.renameSync(child, retiredChild);
            nativeFs.mkdirSync(child);
          } else {
            nativeFs.rmdirSync(child);
            if (replacement === "file") {
              nativeFs.writeFileSync(child, "replacement");
            } else if (replacement === "symlink") {
              nativeFs.symlinkSync(
                target,
                child,
                process.platform === "win32" ? "junction" : "dir",
              );
            }
          }
        }
        return identity;
      });
      const handles: Array<{
        directory: string;
        closed: boolean;
        closeRequested: boolean;
        identity: nativeFs.BigIntStats;
      }> = [];
      const nativeWatch = nativeFs.watch;
      let holdNativeChanges = replacement === "replacement ABA";
      vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
        const deliver = args[1];
        if (replacement === "replacement ABA" && typeof deliver !== "function") {
          throw new Error("Expected a shallow native callback");
        }
        const watchedDirectory = path.resolve(String(args[0]));
        const identity = nativeFs.statSync(watchedDirectory, { bigint: true });
        const native =
          replacement === "replacement ABA" && typeof deliver === "function"
            ? nativeWatch(args[0], (event, filename) => {
                // Only the scan's identity check may repair the first admission.
                // Resume real events after the ready-time acquisition oracle.
                if (!holdNativeChanges) {
                  deliver(event, filename);
                }
              })
            : nativeWatch(...args);
        const observed = {
          directory: watchedDirectory,
          closed: false,
          closeRequested: false,
          identity,
        };
        handles.push(observed);
        native.once("close", () => {
          observed.closed = true;
        });
        if (replacement === "replacement ABA") {
          const close = native.close.bind(native);
          vi.spyOn(native, "close").mockImplementation(() => {
            observed.closeRequested = true;
            close();
          });
        }
        if (observed.directory === child && !replaced && replacement === "replacement directory") {
          // The new snapshot must not certify a handle acquired on the old inode.
          nativeFs.renameSync(child, retiredChild);
          nativeFs.mkdirSync(child);
          replaced = true;
        }
        return native;
      });
      const readdir = fs.readdir;
      let restored = false;
      const read = vi.spyOn(fs, "readdir").mockImplementation((...args) => {
        if (
          replacement === "replacement ABA" &&
          path.resolve(String(args[0])) === child &&
          !restored
        ) {
          // Native before/watch/after all saw B; restore A before the real
          // listing so an earlier scanner snapshot cannot certify B's handle.
          restored = true;
          nativeFs.renameSync(child, path.join(root, "retired-replacement"));
          nativeFs.renameSync(retiredChild, child);
        }
        return readdir(...args);
      });
      const watcher = watch(directory);
      const errors: unknown[] = [];
      watcher.on("error", (error) => errors.push(error));
      try {
        await ready(watcher);
        const normalize = (value: string) => value.replaceAll("\\", "/");
        expect(replaced).toBe(true);
        const admitted = [directory, sibling];
        if (replacement === "replacement directory" || replacement === "replacement ABA") {
          admitted.push(child);
          if (replacement === "replacement ABA") {
            expect(restored).toBe(true);
            expect(originalChild).toBeDefined();
            const childHandles = handles.filter((handle) => handle.directory === child);
            expect(childHandles[0]).toBeDefined();
            expect([childHandles[0]!.identity.dev, childHandles[0]!.identity.ino]).not.toEqual([
              originalChild!.dev,
              originalChild!.ino,
            ]);
            expect(childHandles).toHaveLength(2);
            expect(childHandles[1]!.identity).toMatchObject({
              dev: originalChild!.dev,
              ino: originalChild!.ino,
            });
            expect(childHandles.map(({ closeRequested }) => closeRequested)).toEqual([true, false]);
            expect(childHandles[1]!.closed).toBe(false);
            expect(errors).toEqual([]);
          } else {
            expect(handles.some((handle) => handle.directory === child && handle.closed)).toBe(
              true,
            );
          }
        } else {
          expect(handles.some((handle) => handle.directory === child)).toBe(false);
          expect(read.mock.calls.some(([scanned]) => path.resolve(String(scanned)) === child)).toBe(
            false,
          );
        }
        expect([...watcher.directories].toSorted()).toEqual(admitted.map(normalize).toSorted());
        expect(handles.some((handle) => handle.directory === target)).toBe(false);
        holdNativeChanges = false;

        // Finish setup before the parent callback can admit a new deep registration.
        if (replacement === "file" || replacement === "symlink") {
          nativeFs.unlinkSync(child);
        }
        nativeFs.mkdirSync(deep, { recursive: true });
        nativeFs.writeFileSync(file, "replacement");
        await vi.waitFor(() => expect(watcher.directories.has(normalize(deep))).toBe(true));
        let changed = false;
        watcher.on("raw", (_event, filename, details) => {
          if (
            typeof filename === "string" &&
            resolveRawSkillsWatchPath(filename, details)?.replaceAll("\\", "/") === normalize(file)
          ) {
            changed = true;
          }
        });
        await fs.writeFile(file, "later deep edit");
        await vi.waitFor(() => expect(changed).toBe(true));
        expect(errors).toEqual([]);
        expect(handles.some((handle) => handle.directory === target)).toBe(false);
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
      } finally {
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
      }
    },
  );

  it("limits native registrations to admitted directories and observes symlinks without following them", async () => {
    const tree = path.join(root, "tree");
    const outside = path.join(root, "outside");
    await fs.mkdir(path.join(tree, "child", "too-deep"), { recursive: true });
    await fs.mkdir(path.join(tree, "node_modules", "ignored"), { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(tree, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await fs.writeFile(path.join(tree, "SKILL.md"), "initial");
    const watcher = watch(tree, 1);
    await ready(watcher);
    const normalize = (value: string) => value.replaceAll("\\", "/");
    expect([...watcher.directories].toSorted()).toEqual(
      [tree, path.join(tree, "child")].map(normalize).toSorted(),
    );
    const alias = watch(path.join(tree, "linked"));
    await ready(alias);
    expect([...alias.directories]).toEqual([normalize(tree)]);
    expect(alias.directories.has(normalize(outside))).toBe(false);
  });

  it("acquires the replacement inode while an independent persistent Chokidar peer retains the old path", async () => {
    const directory = path.join(root, "skills");
    const child = path.join(directory, "child");
    const file = path.join(child, "SKILL.md");
    await fs.mkdir(child, { recursive: true });
    await fs.writeFile(file, "old");
    const handles: Array<{ directory: string; retired: boolean }> = [];
    const nativeWatch = nativeFs.watch;
    vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
      const native = nativeWatch(...args);
      const observed = { directory: path.resolve(String(args[0])), retired: false };
      handles.push(observed);
      native.once("close", () => {
        observed.retired = true;
      });
      native.once("error", () => {
        observed.retired = true;
      });
      return native;
    });
    syncBuiltinESMExports();
    const peer = chokidar.watch(directory, {
      ignoreInitial: true,
      persistent: true,
      usePolling: false,
      // Retain the root registry entry without descendant handles, which
      // prohibit an ancestor rename on Windows independently of share-delete.
      depth: 0,
    });
    const peerErrors: unknown[] = [];
    peer.on("error", (error) => peerErrors.push(error));
    try {
      await new Promise<void>((resolve, reject) => {
        peer.once("ready", resolve);
        peer.once("error", reject);
      });
      expect(handles).toEqual([{ directory, retired: false }]);
      const peerHandle = handles[0]!;
      const retired = watch(directory);
      await ready(retired);
      const originalInode = (await fs.stat(directory)).ino;
      expect(await retired.close()).toEqual({ ok: true, value: undefined });
      expect(peerHandle.retired).toBe(false);
      nativeFs.renameSync(directory, path.join(root, "retained-inode"));
      nativeFs.mkdirSync(child, { recursive: true });
      nativeFs.writeFileSync(file, "replacement");
      expect((await fs.stat(directory)).ino).not.toBe(originalInode);
      const replacement = watch(directory);
      await ready(replacement);
      let changed = false;
      replacement.on("raw", (_event, filename, details) => {
        if (typeof filename === "string" && resolveRawSkillsWatchPath(filename, details) === file) {
          changed = true;
        }
      });
      await fs.writeFile(file, "fresh deep edit");
      await vi.waitFor(() => expect(changed).toBe(true));
      expect(peer.closed).toBe(false);
      expect(peerHandle.retired).toBe(false);
      expect(peerErrors).toEqual([]);
      expect(await fs.readFile(file, "utf8")).toBe("fresh deep edit");
    } finally {
      await peer.close();
    }
  });
});
