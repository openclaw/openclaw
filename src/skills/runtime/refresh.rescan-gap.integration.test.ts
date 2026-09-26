import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import * as nativeContent from "./refresh-content-native.js";
import { resolveSkillsWatcherUsePolling } from "./refresh-watch-path.js";
import type { SkillsDirectoryWatcher } from "./refresh-watch-types.js";

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

async function verifyNativeCoverage(
  phase: "initial" | "replacement",
  mode:
    | "root"
    | "nested"
    | "error"
    | "root-read-loss"
    | "root-stat-loss"
    | "child-permission-loss" = "root",
  prelisted = false,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-rescan-")));
  const workspaceDir = path.join(root, "workspace");
  const skillsRoot = path.join(workspaceDir, "skills");
  const firstDir = path.join(skillsRoot, "first");
  const secondDir = path.join(skillsRoot, "second");
  const skillDir = mode === "root" ? secondDir : path.join(secondDir, "child");
  const skillFile = path.join(skillDir, "SKILL.md");
  const writeSkill = () => {
    nativeFs.mkdirSync(skillDir, { recursive: true });
    nativeFs.writeFileSync(
      skillFile,
      "---\nname: rescan-proof\ndescription: Native rescan coverage\n---\n",
    );
  };
  await fs.mkdir(skillsRoot, { recursive: true });
  const childLoss = mode === "child-permission-loss";
  if (childLoss) {
    await fs.mkdir(firstDir);
  }
  if (prelisted) {
    writeSkill();
  }
  const { ensureSkillsWatcher, closeSkillsWatchers } = await import("./refresh.js");
  const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
  const read = () =>
    loadWorkspaceSkills(workspaceDir, {
      config: {},
      workspaceOnly: true,
      bundledSkillsDir: "",
      managedSkillsDir: path.join(root, "unused"),
    }).map((entry) => entry.skill.name);

  const contentScan = new AsyncLocalStorage<number | undefined>();
  const releaseScan = createDeferredCore();
  const releaseNested = createDeferredCore();
  const releaseRootRead = createDeferredCore();
  const watches: Array<{
    generation?: number;
    ready: boolean;
    directories: string[];
    watcher: ReturnType<typeof chokidar.watch> | SkillsDirectoryWatcher;
  }> = [];
  const errors: unknown[] = [];
  const scanError = Object.assign(new Error("verification directory read failed"), {
    code: "EIO",
    syscall: "scandir",
  });
  let generationCount = 0;
  let firstGeneration = 0;
  let armed = phase === "initial";
  let snapshotCaptured = false;
  let snapshotContainsSecond = false;
  let nestedCaptured = false;
  let nestedContainsChild = false;
  let errorInjected = false;
  let nativeCreationObserved = false;
  let nativeNestedCreationObserved = false;
  const rootLoss = mode === "root-read-loss" || mode === "root-stat-loss";
  let rootReadCaptured = false;
  let rootStatLossArmed = false;
  let rootLossError: unknown;
  let rootInodeBefore: number | undefined;
  let rootInodeAfter: number | undefined;
  let holdNativeEvents = false;
  const delayedNativeEvents: Array<() => void> = [];
  const restoreNativeEmits: Array<() => void> = [];
  const nativeRegistrations: Array<{
    generation: number;
    directory: string;
    watcher: nativeFs.FSWatcher;
    retired: boolean;
  }> = [];
  const removeRoot = () => {
    holdNativeEvents = true;
    rootInodeBefore = nativeFs.statSync(skillsRoot).ino;
    nativeFs.renameSync(skillsRoot, path.join(root, "retired-root"));
  };
  const restoreRoot = () => {
    writeSkill();
    rootInodeAfter = nativeFs.statSync(skillsRoot).ino;
  };
  const expectedErrors = () => (errorInjected ? [scanError] : []);
  const originalWatch = chokidar.watch;
  const watch = vi.spyOn(chokidar, "watch").mockImplementation((...args) => {
    const isContentRoot = args[0] === skillsRoot && (args[1]?.depth ?? 0) > 0;
    const generation = isContentRoot ? ++generationCount : undefined;
    return contentScan.run(generation, () => {
      const watcher = originalWatch(...args);
      const observation = { generation, ready: false, directories: [] as string[], watcher };
      watches.push(observation);
      watcher.once("ready", () => {
        observation.ready = true;
        observation.directories = Object.keys(watcher.getWatched());
      });
      watcher.on("error", (error) => errors.push(error));
      return watcher;
    });
  });
  const originalNativeContent = nativeContent.createNativeSkillsContentWatcher;
  const watchContent = vi
    .spyOn(nativeContent, "createNativeSkillsContentWatcher")
    .mockImplementation((...args) => {
      const generation = args[0] === skillsRoot ? ++generationCount : undefined;
      return contentScan.run(generation, () => {
        const watcher = originalNativeContent(...args);
        const observation = { generation, ready: false, directories: [] as string[], watcher };
        watches.push(observation);
        watcher.on("ready", () => {
          observation.ready = true;
          observation.directories = [...watcher.directories];
        });
        watcher.on("error", (error) => errors.push(error));
        return watcher;
      });
    });
  const originalReaddir = fs.readdir;
  const readdir = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
    const entries = await originalReaddir(...args);
    const generation = contentScan.getStore();
    const directory = path.resolve(String(args[0]));
    if (armed && generation !== undefined && directory === skillsRoot && !snapshotCaptured) {
      armed = false;
      // Preserve the real listing while another directory appears. The owner
      // must retain observation across this scan and subsequent verification.
      firstGeneration = generation;
      snapshotContainsSecond = entries.some(
        (entry) => String(typeof entry === "string" ? entry : entry.name) === "second",
      );
      snapshotCaptured = true;
      await releaseScan.promise;
    }
    if (generation === firstGeneration + 1) {
      if (mode === "nested" && directory === secondDir && !nestedCaptured) {
        nestedContainsChild = entries.some(
          (entry) => String(typeof entry === "string" ? entry : entry.name) === "child",
        );
        nestedCaptured = true;
        await releaseNested.promise;
      } else if (mode === "error" && directory === skillsRoot && !errorInjected) {
        // Fail the actual verifier read, after it acquired its real listing.
        errorInjected = true;
        throw scanError;
      } else if (rootLoss && directory === skillsRoot && !rootReadCaptured) {
        rootReadCaptured = true;
        await releaseRootRead.promise;
        if (mode === "root-read-loss") {
          removeRoot();
          try {
            return await originalReaddir(...args);
          } catch (error) {
            rootLossError = error;
            throw error;
          } finally {
            restoreRoot();
          }
        }
        rootStatLossArmed = true;
      }
    }
    return entries;
  });
  const originalLstat = nativeFs.lstatSync;
  const lstat = vi.spyOn(nativeFs, "lstatSync").mockImplementation((...args) => {
    if (
      rootStatLossArmed &&
      contentScan.getStore() === firstGeneration + 1 &&
      path.resolve(String(args[0])) === skillsRoot
    ) {
      rootStatLossArmed = false;
      removeRoot();
      try {
        return originalLstat(...args);
      } catch (error) {
        rootLossError = error;
        throw error;
      } finally {
        restoreRoot();
      }
    }
    return originalLstat(...args);
  });
  const originalNativeWatch = nativeFs.watch;
  const watchNative = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
    const watcher = originalNativeWatch(...args);
    const generation = contentScan.getStore();
    if ((rootLoss || childLoss) && generation !== undefined) {
      const registration = {
        generation,
        directory: path.resolve(String(args[0])),
        watcher,
        retired: false,
      };
      nativeRegistrations.push(registration);
      watcher.once("close", () => {
        registration.retired = true;
      });
      const emit = watcher.emit.bind(watcher);
      const delivery = vi.spyOn(watcher, "emit").mockImplementation((event, ...values) => {
        // The OS notifications are real; hold only product change delivery so
        // the verifier must establish coverage before old callbacks can help.
        if (holdNativeEvents && event === "change") {
          delayedNativeEvents.push(() => emit(event, ...values));
          return true;
        }
        return emit(event, ...values);
      });
      restoreNativeEmits.push(() => delivery.mockRestore());
    }
    return watcher;
  });
  syncBuiltinESMExports();
  const pendingTimers = new Map<
    Parameters<typeof clearTimeout>[0],
    { settled: Promise<void>; finish(): void }
  >();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timeoutSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, delay, ...args) => {
      const { promise: settled, resolve: finish } = createDeferredCore();
      const timer = originalSetTimeout(() => {
        pendingTimers.delete(timer);
        try {
          callback.apply(timer, args);
        } finally {
          finish();
        }
      }, delay);
      pendingTimers.set(timer, { settled, finish });
      return timer;
    });
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
    originalClearTimeout(timer);
    pendingTimers.get(timer)?.finish();
    pendingTimers.delete(timer);
  });
  const settleWatchers = async () => {
    for (;;) {
      await Promise.resolve();
      await vi.waitFor(() => {
        expect(errors).toEqual(expectedErrors());
        expect(watches.every(({ ready, watcher }) => ready || watcher.closed)).toBe(true);
      });
      const settledGenerationCount = watches.length;
      // Drain actual debounce/stability work before priming the cache. A late
      // ready-time publication must not mask missing native descendant coverage.
      await Promise.all(Array.from(pendingTimers.values(), ({ settled }) => settled));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(errors).toEqual(expectedErrors());
      if (
        pendingTimers.size === 0 &&
        watches.length === settledGenerationCount &&
        watches.every(({ ready, watcher }) => ready || watcher.closed)
      ) {
        return;
      }
    }
  };
  let observation: ReturnType<typeof nativeFs.watch> | undefined;
  let nestedObservation: ReturnType<typeof nativeFs.watch> | undefined;

  try {
    observation = nativeFs.watch(skillsRoot, (_event, filename) => {
      if (String(filename) === "second") {
        nativeCreationObserved = true;
      }
    });
    const params = {
      workspaceDir,
      config: {},
      sourcePlan: resolveWorkspaceSkillSourcePlan(workspaceDir, { workspaceOnly: true }),
    };
    ensureSkillsWatcher(params);
    if (phase === "replacement") {
      await settleWatchers();
      expect(read()).toEqual([]);
      armed = true;
      nativeFs.mkdirSync(firstDir);
    }
    await expect.poll(() => snapshotCaptured, { timeout: 3_000 }).toBe(true);
    expect(snapshotContainsSecond).toBe(prelisted);

    if (!prelisted) {
      nativeFs.mkdirSync(secondDir);
      if (mode !== "nested") {
        writeSkill();
      }
    }
    // This independent observation establishes that the real OS event occurred
    // before scan release; it never forwards events to the product watcher.
    if (!prelisted) {
      await expect.poll(() => nativeCreationObserved, { timeout: 3_000 }).toBe(true);
    }
    releaseScan.resolve();
    if (rootLoss) {
      await expect.poll(() => rootReadCaptured, { timeout: 3_000 }).toBe(true);
      releaseRootRead.resolve();
    }
    if (mode === "nested") {
      await expect.poll(() => nestedCaptured, { timeout: 3_000 }).toBe(true);
      expect(nestedContainsChild).toBe(prelisted);
      nestedObservation = nativeFs.watch(secondDir, (_event, filename) => {
        if (String(filename) === "child") {
          nativeNestedCreationObserved = true;
        }
      });
      if (!prelisted) {
        writeSkill();
        await expect.poll(() => nativeNestedCreationObserved, { timeout: 3_000 }).toBe(true);
      }
      releaseNested.resolve();
    }
    await settleWatchers();
    if (rootLoss) {
      expect(rootLossError).toMatchObject({ code: "ENOENT" });
      expect(rootInodeAfter).not.toBe(rootInodeBefore);
      const verifier = watches.find(({ generation }) => generation === firstGeneration + 1)!;
      expect(verifier.ready).toBe(true);
      expect(verifier.watcher.closed).toBe(false);
      expect(verifier.directories).toEqual(expect.arrayContaining([skillsRoot, skillDir]));
      holdNativeEvents = false;
      delayedNativeEvents.splice(0).forEach((deliver) => deliver());
      await settleWatchers();
    }
    if (mode !== "root") {
      const observer = watches.find(({ generation }) => generation === firstGeneration)!;
      // The owned initial scan reconciles real events before its first ready.
      // A child created later inside the held verifier still belongs to that verifier.
      expect(observer.directories.includes(skillDir)).toBe(
        mode === "error" || rootLoss || childLoss || prelisted,
      );
      if (mode === "error") {
        expect(errorInjected).toBe(true);
        expect(errors).toEqual([scanError]);
        expect(errors[0]).toBe(scanError);
        expect(observer.watcher.closed).toBe(false);
        expect(
          watches.find(({ generation }) => generation === firstGeneration + 1)!.watcher.closed,
        ).toBe(true);
      }
    }
    expect(read()).toEqual(["rescan-proof"]);
    if (childLoss) {
      const active = watches.find(
        ({ generation, watcher }) => generation !== undefined && !watcher.closed,
      )!;
      const children = nativeRegistrations.filter(
        ({ generation, directory, retired }) =>
          generation === active.generation && directory === firstDir && !retired,
      );
      expect(children).toHaveLength(1);
      const child = children[0]!.watcher;
      holdNativeEvents = true;
      const retired = once(child, "close");
      child.close();
      await retired;
      nativeFs.rmdirSync(firstDir);
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        // Inject the documented terminal Windows boundary before any parent
        // notification can reconcile deletion. This is not native Windows proof.
        Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
        child.emit("error", Object.assign(new Error("child deleted"), { code: "EPERM" }));
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
      expect(errors).toEqual([]);
      expect((active.watcher as SkillsDirectoryWatcher).directories.has(firstDir)).toBe(false);
      await settleWatchers();
      expect(delayedNativeEvents.length).toBeGreaterThan(0);
      holdNativeEvents = false;
      delayedNativeEvents.splice(0).forEach((deliver) => deliver());
      await settleWatchers();
      expect(read()).toEqual(["rescan-proof"]);
    }

    // A ready-time inventory alone discovers the sibling, but cannot observe
    // later changes inside it unless the replacement has native coverage.
    nativeFs.renameSync(skillFile, path.join(skillDir, "SKILL.saved"));
    if (mode === "error") {
      // Preparation, not another filesystem notification or repeated polling,
      // must refresh the cache while verification remains unavailable.
      expect(read()).toEqual(["rescan-proof"]);
      ensureSkillsWatcher(params);
      expect(read()).toEqual([]);
    }
    await expect.poll(read, { timeout: 3_000 }).toEqual([]);
    expect(errors).toEqual(expectedErrors());
  } finally {
    releaseScan.resolve();
    releaseNested.resolve();
    releaseRootRead.resolve();
    observation?.close();
    nestedObservation?.close();
    let joined = false;
    try {
      await closeSkillsWatchers(true);
      holdNativeEvents = false;
      delayedNativeEvents.splice(0).forEach((deliver) => deliver());
      joined = true;
    } finally {
      readdir.mockRestore();
      watch.mockRestore();
      watchContent.mockRestore();
      watchNative.mockRestore();
      lstat.mockRestore();
      restoreNativeEmits.forEach((restore) => restore());
      timeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      syncBuiltinESMExports();
      if (joined) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  }
}

it
  .runIf(process.platform === "linux" && !process.versions.bun && !resolveSkillsWatcherUsePolling())
  .each(["initial", "replacement"] as const)(
  "keeps native coverage for a sibling created during the %s root scan",
  (phase) => verifyNativeCoverage(phase),
);

it
  .runIf(process.platform === "linux" && !process.versions.bun && !resolveSkillsWatcherUsePolling())
  .each([false, true])(
  "keeps native coverage for a nested verifier gap (prelisted=%s)",
  (prelisted) => verifyNativeCoverage("initial", "nested", prelisted),
);

it
  .runIf(process.platform === "linux" && !process.versions.bun && !resolveSkillsWatcherUsePolling())
  .each([false, true])(
  "refreshes preparation after a verifier read error (prelisted=%s)",
  (prelisted) => verifyNativeCoverage("initial", "error", prelisted),
);

it
  .runIf(process.platform === "linux" && !process.versions.bun && !resolveSkillsWatcherUsePolling())
  .each(["root-read-loss", "root-stat-loss"] as const)(
  "re-admits a recreated root after a held verifier's %s before publishing coverage",
  (mode) => verifyNativeCoverage("initial", mode),
);

it.runIf(
  process.platform === "linux" && !process.versions.bun && !resolveSkillsWatcherUsePolling(),
)("keeps cached sibling coverage when a deleted child reports terminal Windows EPERM first", () =>
  verifyNativeCoverage("initial", "child-permission-loss"),
);
