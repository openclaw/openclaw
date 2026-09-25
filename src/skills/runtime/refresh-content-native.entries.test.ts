import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { SkillsNativeWatchInvalidatedError } from "./refresh-ancestor-native.js";
import { createNativeSkillsContentWatcher } from "./refresh-content-native.js";
import { createSkillsWatchPathFilter, resolveRawSkillsWatchPath } from "./refresh-watch-path.js";
import { shouldUseNativeSkillsWatcher } from "./refresh-watch-transport.js";
import type { SkillsDirectoryWatcher } from "./refresh-watch-types.js";
import {
  captureNativeCallbacks,
  deliverWindowsNotification,
  ready,
} from "./refresh.native.test-support.js";

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

  it.each(["settled", "parent admission", "parent replacement"] as const)(
    "reconciles repeated logical-root removal from %s under the same parent",
    async (seam) => {
      const parent = path.join(root, "source");
      const target = path.join(root, "target");
      const link = path.join(parent, "long-skills-root");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await fs.mkdir(parent);
      await fs.mkdir(target);
      await fs.symlink(target, link, linkType);
      let previousParent: nativeFs.BigIntStats | undefined;
      const parentStat = nativeFs.statSync;
      if (seam === "parent replacement") {
        vi.spyOn(nativeFs, "statSync").mockImplementation((...args) => {
          const identity = parentStat(...args);
          if (
            path.resolve(String(args[0])) === parent &&
            typeof identity?.ino === "bigint" &&
            !previousParent
          ) {
            // The scanner sees A; every native admission probe and the handle
            // see B. Later absence must use the identity actually observed.
            previousParent = identity as nativeFs.BigIntStats;
            nativeFs.renameSync(parent, path.join(root, "retired-parent"));
            nativeFs.mkdirSync(parent);
            nativeFs.symlinkSync(target, link, linkType);
          }
          return identity;
        });
      }
      let removedDuringAdmission = false;
      const acquiredParents: nativeFs.BigIntStats[] = [];
      const handles = captureNativeCallbacks((directory) => {
        if (directory === parent) {
          acquiredParents.push(parentStat(parent, { bigint: true }));
        }
        if (seam === "parent admission" && directory === parent && !removedDuringAdmission) {
          // The real parent handle exists, but no logical leaf was published.
          nativeFs.unlinkSync(link);
          removedDuringAdmission = true;
        }
      });
      const listing = vi.spyOn(fs, "readdir");
      const changes: Array<[string, string]> = [];
      const errors: unknown[] = [];
      const watcher = watch(link);
      watcher.on("all", (event, changedPath) => changes.push([event, changedPath]));
      watcher.on("error", (error) => errors.push(error));
      try {
        await ready(watcher);
        expect(removedDuringAdmission).toBe(seam === "parent admission");
        expect(handles.map(({ directory }) => directory)).toEqual([parent]);
        if (seam === "parent replacement") {
          expect(previousParent).toBeDefined();
          expect(acquiredParents).toHaveLength(1);
          expect([acquiredParents[0]!.dev, acquiredParents[0]!.ino]).not.toEqual([
            previousParent!.dev,
            previousParent!.ino,
          ]);
        }
        const observer = handles[0]!;
        const normalizedLink = link.replaceAll("\\", "/");
        const expected: Array<[string, string]> = [];
        const reconcile = async () => {
          deliverWindowsNotification(() => observer.deliver("rename", "LONG-S~1"));
          // Entry-parent scans are synchronous; join their continuation without
          // allowing an incidental native event to repair the controlled callback.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        };
        if (!removedDuringAdmission) {
          nativeFs.unlinkSync(link);
          await reconcile();
          expect(errors).toEqual([]);
          expected.push(["unlink", normalizedLink]);
          expect(changes).toHaveLength(1);
          expect(changes).toEqual(expected);
        }
        nativeFs.symlinkSync(target, link, linkType);
        await reconcile();
        expected.push(["add", normalizedLink]);
        expect(changes).toEqual(expected);
        nativeFs.unlinkSync(link);
        await reconcile();
        expected.push(["unlink", normalizedLink]);
        expect(changes).toEqual(expected);
        expect([...watcher.directories]).toEqual([parent.replaceAll("\\", "/")]);
        expect(handles).toHaveLength(1);
        expect(observer.closed).toBe(false);
        expect(listing).not.toHaveBeenCalled();
        expect(errors).toEqual([]);
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
      } finally {
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
      }
    },
  );

  it.each(["unadmitted", "real directory"] as const)(
    "keeps missing %s roots fatal instead of certifying parent coverage",
    async (kind) => {
      const directory = path.join(root, "skills");
      if (kind === "real directory") {
        await fs.mkdir(directory);
      }
      const handles = captureNativeCallbacks();
      const errors: unknown[] = [];
      const watcher = watch(directory);
      const onReady = vi.fn();
      watcher.on("ready", onReady);
      watcher.on("error", (error) => errors.push(error));
      try {
        if (kind === "real directory") {
          await ready(watcher);
          await fs.rmdir(directory);
          deliverWindowsNotification(() => handles[0]!.deliver("rename", "SKILLS~1"));
        }
        await vi.waitFor(() => expect(errors).toHaveLength(1));
        expect(errors[0]).toMatchObject({ code: "ENOENT" });
        expect(onReady).toHaveBeenCalledTimes(kind === "real directory" ? 1 : 0);
        expect(handles).toHaveLength(kind === "real directory" ? 1 : 0);
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
      } finally {
        await watcher.close();
      }
    },
  );

  it.each([
    ["parent", "identity"],
    ["parent", "EACCES"],
    ["parent", "EIO"],
    ["root", "EACCES"],
    ["root", "EIO"],
  ] as const)(
    "does not turn a %s %s failure into healthy logical-root absence",
    async (probe, cause) => {
      const parent = path.join(root, "source");
      const target = path.join(root, "target");
      const link = path.join(parent, "long-skills-root");
      await fs.mkdir(parent);
      await fs.mkdir(target);
      await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      const handles = captureNativeCallbacks();
      const errors: unknown[] = [];
      const changes = vi.fn();
      const watcher = watch(link);
      watcher.on("error", (error) => errors.push(error));
      watcher.on("all", changes);
      try {
        await ready(watcher);
        nativeFs.unlinkSync(link);
        const failure = Object.assign(new Error(`owned ${probe} probe failed`), { code: cause });
        if (cause === "identity") {
          const previous = nativeFs.statSync(parent, { bigint: true });
          nativeFs.renameSync(parent, path.join(root, "retired-parent"));
          nativeFs.mkdirSync(parent);
          expect(nativeFs.statSync(parent, { bigint: true }).ino).not.toBe(previous.ino);
        } else {
          const method = probe === "parent" ? "statSync" : "lstatSync";
          const original = nativeFs[method];
          vi.spyOn(nativeFs, method).mockImplementation((...args) => {
            if (path.resolve(String(args[0])) === (probe === "parent" ? parent : link)) {
              throw failure;
            }
            return original(...args);
          });
        }
        // A named change reaches the missing-leaf probe without treating the
        // old parent as a self-loss event first. Automatic delivery stays held.
        deliverWindowsNotification(() => handles[0]!.deliver("change", "LONG-S~1"));
        await vi.waitFor(() => expect(errors).toHaveLength(1));
        if (cause === "identity") {
          expect(errors[0]).toBeInstanceOf(SkillsNativeWatchInvalidatedError);
        } else {
          expect(errors[0]).toBe(failure);
        }
        expect(changes).not.toHaveBeenCalled();
        expect(handles).toHaveLength(1);
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
      } finally {
        await watcher.close();
      }
    },
  );

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const)(
    "reconciles a named link change with its initial sibling scan held=%s and short name=%s",
    async (holdInitialScan, shortName) => {
      const directory = path.join(root, "skills");
      const sibling = path.join(directory, "sibling");
      const link = path.join(directory, "link");
      const firstTarget = path.join(root, "first");
      const nextTarget = path.join(root, "next");
      for (const entry of [sibling, firstTarget, nextTarget]) {
        await fs.mkdir(entry, { recursive: true });
      }
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await fs.symlink(firstTarget, link, linkType);
      const handles = captureNativeCallbacks();
      const release = createDeferredCore();
      let held = false;
      const originalRead = fs.readdir;
      vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        const entries = await originalRead(...args);
        if (holdInitialScan && !held && path.resolve(String(args[0])) === sibling) {
          held = true;
          await release.promise;
        }
        return entries;
      });
      const readLink = nativeFs.readlinkSync;
      let latestTarget: string | undefined;
      vi.spyOn(nativeFs, "readlinkSync").mockImplementation((...args) => {
        const result = readLink(...args);
        if (path.resolve(String(args[0])) === link) {
          latestTarget = result;
        }
        return result;
      });
      const watcher = watch(directory);
      const errors: unknown[] = [];
      const events = vi.fn();
      const readyTargets: Array<string | undefined> = [];
      watcher.on("error", (error) => errors.push(error));
      watcher.on("all", events);
      watcher.on("ready", () => readyTargets.push(latestTarget));
      const prepared = ready(watcher);
      const deliver = (event: nativeFs.WatchEventType) => {
        const invoke = () =>
          handles
            .find((handle) => handle.directory === directory)!
            .deliver(event, shortName ? "LINK~1" : "link");
        if (shortName) {
          deliverWindowsNotification(invoke);
        } else {
          invoke();
        }
      };
      try {
        if (holdInitialScan) {
          await vi.waitFor(() => expect(held).toBe(true));
          expect(latestTarget).toBe(readLink(link));
          expect(readyTargets).toEqual([]);
        } else {
          await prepared;
        }
        nativeFs.unlinkSync(link);
        nativeFs.symlinkSync(nextTarget, link, linkType);
        const expectedTarget = readLink(link);
        deliver("change");
        release.resolve();
        if (holdInitialScan) {
          await prepared;
          expect(readyTargets).toEqual([expectedTarget]);
        } else {
          await vi.waitFor(() =>
            expect(events).toHaveBeenCalledWith("change", link.replaceAll("\\", "/")),
          );
          expect(latestTarget).toBe(expectedTarget);
          expect(events).not.toHaveBeenCalledWith("unlink", expect.anything());
        }
        expect(handles.some(({ directory: watched }) => watched === nextTarget)).toBe(false);
        nativeFs.unlinkSync(link);
        deliver("rename");
        await vi.waitFor(() =>
          expect(events).toHaveBeenCalledWith("unlink", link.replaceAll("\\", "/")),
        );
        expect(errors).toEqual([]);
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
      } finally {
        release.resolve();
        await watcher.close();
      }
    },
  );

  it.each([
    [false, "SKILL.md"],
    [true, "SKILL.md"],
    [false, "notes.txt"],
    [true, "notes.txt"],
  ] as const)(
    "keeps regular named changes out of scans with held=%s file=%s",
    async (held, name) => {
      const directory = path.join(root, "skills");
      const sibling = path.join(directory, "sibling");
      const file = path.join(directory, name);
      await fs.mkdir(sibling, { recursive: true });
      await fs.writeFile(file, "before");
      const handles = captureNativeCallbacks();
      const release = createDeferredCore();
      let entered = false;
      const originalRead = fs.readdir;
      const read = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        const entries = await originalRead(...args);
        if (held && path.resolve(String(args[0])) === sibling) {
          entered = true;
          await release.promise;
        }
        return entries;
      });
      const watcher = watch(directory);
      const errors: unknown[] = [];
      const raw = vi.fn();
      watcher.on("error", (error) => errors.push(error));
      watcher.on("raw", raw);
      const prepared = ready(watcher);
      try {
        if (held) {
          await vi.waitFor(() => expect(entered).toBe(true));
        } else {
          await prepared;
        }
        nativeFs.writeFileSync(file, "after");
        handles.find((handle) => handle.directory === directory)!.deliver("change", name);
        deliverWindowsNotification(() =>
          handles.find((handle) => handle.directory === directory)!.deliver("change", name),
        );
        expect(raw).toHaveBeenCalledWith("change", name, expect.any(Object));
        expect(raw).toHaveBeenCalledTimes(2);
        release.resolve();
        await prepared;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(read.mock.calls.map(([entry]) => path.resolve(String(entry)))).toEqual([
          directory,
          sibling,
        ]);
        expect(errors).toEqual([]);
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
      } finally {
        release.resolve();
        await watcher.close();
      }
    },
  );

  it.each(["missing", "probe error", "owned scan error"] as const)(
    "reconciles a named change with %s through the owned scan",
    async (condition) => {
      const handles = captureNativeCallbacks();
      const watcher = watch(root);
      const errors: unknown[] = [];
      const readyEvents = vi.fn();
      watcher.on("error", (error) => errors.push(error));
      watcher.on("ready", readyEvents);
      await ready(watcher);
      const changedPath = path.join(root, "unknown");
      const probeFailure = Object.assign(new Error("changed entry inaccessible"), {
        code: "EACCES",
      });
      const scanFailure = Object.assign(new Error("owned directory read failed"), { code: "EIO" });
      const lstat = nativeFs.lstatSync;
      vi.spyOn(nativeFs, "lstatSync").mockImplementation((...args) => {
        if (condition !== "missing" && path.resolve(String(args[0])) === changedPath) {
          throw probeFailure;
        }
        return lstat(...args);
      });
      const originalRead = fs.readdir;
      const read = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (condition === "owned scan error") {
          throw scanFailure;
        }
        return originalRead(...args);
      });
      try {
        expect(() =>
          deliverWindowsNotification(() => handles[0]!.deliver("change", "unknown")),
        ).not.toThrow();
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(errors).toEqual(condition === "owned scan error" ? [scanFailure] : []);
        expect(readyEvents).toHaveBeenCalledOnce();
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
        const reads = read.mock.calls.length;
        const probe = vi.spyOn(nativeFs, "lstatSync");
        probe.mockClear();
        deliverWindowsNotification(() => handles[0]!.deliver("change", "unknown"));
        expect(probe).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalledTimes(reads);
      } finally {
        await watcher.close();
      }
    },
  );

  it.each(["listed child", "root readlink", "root parent watch"] as const)(
    "admits a real directory replacing a symlink during %s",
    async (seam) => {
      const directory = path.join(root, "skills");
      const formerTarget = path.join(root, "former-target");
      const candidate = seam === "listed child" ? path.join(directory, "linked") : directory;
      const deep = path.join(candidate, "deep");
      const file = path.join(deep, "SKILL.md");
      await fs.mkdir(formerTarget);
      if (seam === "listed child") {
        await fs.mkdir(directory);
      }
      await fs.symlink(formerTarget, candidate, process.platform === "win32" ? "junction" : "dir");
      expect(nativeFs.lstatSync(candidate).isSymbolicLink()).toBe(true);
      const release = createDeferredCore();
      let captured = false;
      let replaced = false;
      const replace = () => {
        nativeFs.unlinkSync(candidate);
        nativeFs.mkdirSync(deep, { recursive: true });
        nativeFs.writeFileSync(file, "replacement");
        replaced = true;
      };
      let capturedSymlink = false;
      let readlinkFailure: unknown;
      if (seam === "listed child") {
        const readdir = fs.readdir;
        vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
          const children = await readdir(...args);
          if (path.resolve(String(args[0])) === directory && !replaced) {
            capturedSymlink = children.some(
              (child) => String(child.name) === "linked" && child.isSymbolicLink(),
            );
            captured = true;
            await release.promise;
          }
          return children;
        });
      } else if (seam === "root readlink") {
        const readlink = nativeFs.readlinkSync;
        vi.spyOn(nativeFs, "readlinkSync").mockImplementation((...args) => {
          if (path.resolve(String(args[0])) === candidate && !replaced) {
            replace();
          }
          try {
            return readlink(...args);
          } catch (error) {
            readlinkFailure = error;
            throw error;
          }
        });
      }
      const nativeWatch = nativeFs.watch;
      const handles: Array<{ closed: boolean }> = [];
      const acquire = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
        if (
          seam === "root parent watch" &&
          path.resolve(String(args[0])) === path.dirname(candidate) &&
          !replaced
        ) {
          // No parent handle exists yet, so no native event can repair a stale
          // logical-root snapshot after this real replacement.
          replace();
        }
        const native = nativeWatch(...args);
        const observed = { closed: false };
        handles.push(observed);
        native.once("close", () => {
          observed.closed = true;
        });
        return native;
      });
      const watcher = watch(directory);
      const errors: unknown[] = [];
      watcher.on("error", (error) => errors.push(error));
      const initialized = ready(watcher);
      try {
        if (seam === "listed child") {
          await vi.waitFor(() => expect(captured).toBe(true));
          expect(capturedSymlink).toBe(true);
          replace();
          release.resolve();
        }
        await initialized;
        expect(replaced).toBe(true);
        if (seam === "root readlink") {
          expect(readlinkFailure).toMatchObject({ code: "EINVAL" });
        }
        const normalize = (value: string) => value.replaceAll("\\", "/");
        const expected = seam === "listed child" ? [directory, candidate, deep] : [candidate, deep];
        expect(watcher.directories.size).toBe(expected.length);
        expect([...watcher.directories].toSorted()).toEqual(expected.map(normalize).toSorted());
        expect(acquire.mock.calls.map(([watched]) => normalize(String(watched)))).not.toContain(
          normalize(formerTarget),
        );
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
      } finally {
        release.resolve();
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(handles.every(({ closed }) => closed)).toBe(true);
        expect(errors).toEqual([]);
      }
    },
  );

  it("observes a symbolic root through its aliased logical parent without scanning either target", async () => {
    const parent = path.join(root, "parent-target");
    const target = path.join(root, "skill-target");
    const next = path.join(root, "next-target");
    const alias = path.join(root, "alias");
    const logicalRoot = path.join(alias, "root-link");
    const physicalRoot = path.join(parent, "root-link");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.mkdir(parent);
    await fs.mkdir(target);
    await fs.mkdir(next);
    await fs.symlink(parent, alias, linkType);
    await fs.symlink(target, physicalRoot, linkType);
    const loopRescue = new Error("repeated symbolic-parent admission");
    const lstat = nativeFs.lstatSync;
    let parentReads = 0;
    vi.spyOn(nativeFs, "lstatSync").mockImplementation((...args) => {
      if (path.resolve(String(args[0])) === alias && ++parentReads > 8) {
        // The broken scan otherwise starves timers with resolved-promise retries.
        // This test-only guard turns that loop into a bounded original failure.
        throw loopRescue;
      }
      return lstat(...args);
    });
    const acquire = vi.spyOn(nativeFs, "watch");
    const read = vi.spyOn(fs, "readdir");
    const watcher = watch(logicalRoot);
    const errors: unknown[] = [];
    const changes: Array<[string, string]> = [];
    watcher.on("error", (error) => errors.push(error));
    watcher.on("all", (event, changedPath) => changes.push([event, changedPath]));
    await ready(watcher);
    const normalize = (value: string) => value.replaceAll("\\", "/");
    expect(acquire.mock.calls.map(([directory]) => normalize(String(directory)))).toEqual([
      normalize(alias),
    ]);
    expect([...watcher.directories]).toEqual([normalize(alias)]);
    expect(read).not.toHaveBeenCalled();
    nativeFs.unlinkSync(physicalRoot);
    nativeFs.symlinkSync(next, physicalRoot, linkType);
    await vi.waitFor(() => expect(changes).toContainEqual(["change", normalize(logicalRoot)]));
    expect(read).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
    expect(await watcher.close()).toEqual({ ok: true, value: undefined });
  });
});
