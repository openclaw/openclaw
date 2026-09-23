import { AsyncLocalStorage } from "node:async_hooks";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { resolveSkillsWatcherUsePolling } from "./refresh-watch-path.js";

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

async function verifyNativeCoverage(
  phase: "initial" | "replacement",
  mode: "root" | "nested" | "error" = "root",
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
  const watches: Array<{
    generation?: number;
    ready: boolean;
    directories: string[];
    watcher: ReturnType<typeof chokidar.watch>;
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
  const originalReaddir = fs.readdir;
  const readdir = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
    const entries = await originalReaddir(...args);
    const generation = contentScan.getStore();
    const directory = path.resolve(String(args[0]));
    if (armed && generation !== undefined && directory === skillsRoot && !snapshotCaptured) {
      armed = false;
      // Preserve the real root listing, then create a sibling before this scan
      // can install its native watch. Only the observing generation can see it.
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
      }
    }
    return entries;
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
    if (mode !== "root") {
      const observer = watches.find(({ generation }) => generation === firstGeneration)!;
      expect(observer.directories.includes(skillDir)).toBe(prelisted);
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

    // A ready-time inventory alone discovers the sibling, but cannot observe
    // later changes inside it unless the replacement has native coverage.
    nativeFs.renameSync(skillFile, path.join(skillDir, "SKILL.saved"));
    if (mode === "error") {
      // Preparation, not another filesystem notification or repeated polling,
      // must refresh the cache while verification remains unavailable.
      ensureSkillsWatcher(params);
    }
    await expect.poll(read, { timeout: 3_000 }).toEqual([]);
    expect(errors).toEqual(expectedErrors());
  } finally {
    releaseScan.resolve();
    releaseNested.resolve();
    observation?.close();
    nestedObservation?.close();
    let joined = false;
    try {
      await closeSkillsWatchers(true);
      joined = true;
    } finally {
      readdir.mockRestore();
      watch.mockRestore();
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
