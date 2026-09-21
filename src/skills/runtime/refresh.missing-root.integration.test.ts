import { AsyncLocalStorage } from "node:async_hooks";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { afterEach, describe, expect, it, onTestFailed, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveSkillsWatcherUsePolling } from "./refresh-watch-path.js";

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

it.each(["initial", "closed", "disabled", "evicted"] as const)(
  "reads repaired skills immediately after %s watcher acquisition",
  async (lifecycle) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-acquire-")));
    const workspaceDir = path.join(root, "workspace");
    const skillDir = path.join(workspaceDir, "skills", "acquire-proof");
    const skillFile = path.join(skillDir, "SKILL.md");
    const { ensureSkillsWatcher, closeSkillsWatchers } = await import("./refresh.js");
    const { getSkillsSnapshotVersion } = await import("./refresh-state.js");
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const options = { config: {}, agentId: "main" };
    try {
      await fs.mkdir(skillDir, { recursive: true });
      if (lifecycle !== "initial") {
        ensureSkillsWatcher({ workspaceDir, ...options });
        if (lifecycle === "closed") {
          await closeSkillsWatchers();
        } else if (lifecycle === "disabled") {
          ensureSkillsWatcher({
            workspaceDir,
            ...options,
            config: { skills: { load: { watch: false } } },
          });
        } else {
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60_000);
          try {
            ensureSkillsWatcher({ workspaceDir: path.join(root, "other"), ...options });
          } finally {
            clock.mockRestore();
          }
        }
      }
      // Cache the invalid file after teardown, so teardown invalidation cannot
      // accidentally prove freshness on reacquisition.
      nativeFs.writeFileSync(skillFile, "not valid skill frontmatter\n");
      const readSkill = () =>
        loadWorkspaceSkills(workspaceDir, options).find(
          (entry) => entry.skill.name === "acquire-proof",
        );
      expect(readSkill()).toBeUndefined();
      nativeFs.writeFileSync(
        skillFile,
        "---\nname: acquire-proof\ndescription: Repaired before acquisition\n---\n",
      );
      expect(readSkill()).toBeUndefined();
      // No await: the first synchronous consumer must not need a ready/change event.
      ensureSkillsWatcher({ workspaceDir, ...options });
      expect(readSkill()?.skill.description).toBe("Repaired before acquisition");
      const version = getSkillsSnapshotVersion(workspaceDir);
      ensureSkillsWatcher({ workspaceDir, ...options });
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    } finally {
      await closeSkillsWatchers();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["create", "edit"] as const)(
  "refreshes cached skills after %s during initial watcher registration",
  async (operation) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-scan-proof-")));
    const workspaceDir = path.join(root, "workspace");
    const skillDir = path.join(workspaceDir, "skills", "scan-proof");
    const skillFile = path.join(skillDir, "SKILL.md");
    const contents = (description: string) =>
      `---\nname: scan-proof\ndescription: ${description}\n---\n`;
    const { ensureSkillsWatcher, closeSkillsWatchers } = await import("./refresh.js");
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const options = { config: {}, agentId: "main" };
    try {
      await fs.mkdir(path.dirname(skillDir), { recursive: true });
      if (operation === "edit") {
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(skillFile, contents("Before registration"));
      }
      ensureSkillsWatcher({ workspaceDir, ...options });
      const cached = loadWorkspaceSkills(workspaceDir, options);
      expect(cached.find((entry) => entry.skill.name === "scan-proof")?.skill.description).toBe(
        operation === "edit" ? "Before registration" : undefined,
      );
      // Keep the write in this turn, before native watcher registration, so
      // refresh cannot depend on receiving a subsequent file-change event.
      nativeFs.mkdirSync(skillDir, { recursive: true });
      nativeFs.writeFileSync(skillFile, contents("After registration"));
      await expect
        .poll(
          () =>
            loadWorkspaceSkills(workspaceDir, options).find(
              (entry) => entry.skill.name === "scan-proof",
            )?.skill.description,
          { timeout: 3_000 },
        )
        .toBe("After registration");
    } finally {
      await closeSkillsWatchers();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it("refreshes skills created beneath an initially missing project skills root", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "skills-root-proof-")));
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(path.join(workspaceDir, "skills", "existing"), { recursive: true });
  const registeredPaths = new Set<string>();
  const turnContext = new AsyncLocalStorage<string>();
  const pendingInputContext = new AsyncLocalStorage<string>();
  const inheritedContexts: Array<{ turn?: string; pendingInput?: string }> = [];
  const usePolling = resolveSkillsWatcherUsePolling();
  const observeRegistration = (watched: nativeFs.PathLike, polling: boolean) => {
    inheritedContexts.push({
      turn: turnContext.getStore(),
      pendingInput: pendingInputContext.getStore(),
    });
    if (polling === usePolling) {
      registeredPaths.add(path.resolve(String(watched)));
    }
  };
  const originalWatch = nativeFs.watch;
  const watchObserver = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
    observeRegistration(args[0], false);
    return originalWatch(...args);
  });
  const originalWatchFile = nativeFs.watchFile;
  const watchFileObserver = vi.spyOn(nativeFs, "watchFile").mockImplementation((...args) => {
    observeRegistration(args[0], true);
    return originalWatchFile(...args);
  });
  syncBuiltinESMExports();
  const { ensureSkillsWatcher, closeSkillsWatchers, registerSkillsChangeListener } =
    await import("./refresh.js");
  const changes: string[] = [];
  let readyEvents = 0;
  const unregister = registerSkillsChangeListener((event) => {
    if (event.workspaceDir !== workspaceDir) {
      return;
    }
    if (event.reason === "watch") {
      if (event.changedPath) {
        changes.push(event.changedPath);
      } else {
        readyEvents += 1;
      }
    }
  });
  try {
    turnContext.run("active turn", () => {
      pendingInputContext.run("accepted input", () => {
        ensureSkillsWatcher({ workspaceDir });
        expect(turnContext.getStore()).toBe("active turn");
        expect(pendingInputContext.getStore()).toBe("accepted input");
      });
    });
    const existingSkill = path.join(workspaceDir, "skills", "existing", "SKILL.md");
    // This control covers writes after registration; the cases above cover
    // cached discovery while the initial scan is still pending. Wait for the
    // public ready invalidations because Bun cannot observe Chokidar's already-
    // bound node:fs export through the spy below.
    await vi.waitFor(() => {
      expect(readyEvents).toBe(1);
    });
    // Bun does not project spy replacements onto already-bound node:fs named exports.
    if (!process.versions.bun) {
      await vi.waitFor(() => {
        expect(registeredPaths.has(workspaceDir)).toBe(true);
        expect(registeredPaths.has(path.dirname(existingSkill))).toBe(true);
      });
    }
    await fs.writeFile(existingSkill, "existing skill");
    await vi.waitFor(() => expect(changes).toContain(existingSkill), { timeout: 3_000 });
    const newSkill = path.join(workspaceDir, ".agents", "skills", "new", "SKILL.md");
    await fs.mkdir(path.dirname(newSkill), { recursive: true });
    await fs.writeFile(newSkill, "new skill");
    await vi.waitFor(
      () => {
        expect(
          changes.some((changed) => changed.startsWith(path.join(workspaceDir, ".agents"))),
        ).toBe(true);
      },
      { timeout: 3_000 },
    );
    if (!process.versions.bun) {
      expect(inheritedContexts.length).toBeGreaterThan(0);
      for (const context of inheritedContexts) {
        expect(context).toEqual({ turn: undefined, pendingInput: undefined });
      }
    }
  } finally {
    unregister();
    await closeSkillsWatchers();
    watchObserver.mockRestore();
    watchFileObserver.mockRestore();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("shared missing skill ancestors", () => {
  let captureFailure: (() => void) | undefined;
  const roots = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async ({ task }) => {
      // onTestFailed runs after afterEach. Freeze the failed operation's state
      // before closing watches or clearing their pending timers.
      if (task.result?.state === "fail") {
        captureFailure?.();
      }
      captureFailure = undefined;
      const { closeSkillsWatchers } = await import("./refresh.js");
      await closeSkillsWatchers(true);
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      cleanup();
    }),
  );

  it.each(["higher", "intermediate"] as const)(
    "preserves settled root discovery after moving its %s ancestor and retains sibling subscriptions",
    async (ancestor) => {
      let phase = "create fixture root";
      let failureSnapshot: string | undefined;
      const observed: Array<{
        watcher: ReturnType<typeof chokidar.watch>;
        ready: boolean;
        paths: Parameters<typeof chokidar.watch>[0];
      }> = [];
      const watcherErrors: unknown[] = [];
      const nativeAncestor =
        process.platform === "linux" && !process.versions.bun && !resolveSkillsWatcherUsePolling();
      const nativeHandles: Array<{ closed: boolean }> = [];
      const originalNativeWatch = nativeFs.watch;
      const nativeWatch = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
        const watcher = originalNativeWatch(...args);
        const observation = { closed: false };
        nativeHandles.push(observation);
        watcher.once("close", () => {
          observation.closed = true;
        });
        watcher.on("error", (error) => {
          observation.closed = true;
          watcherErrors.push(error);
        });
        return watcher;
      });
      syncBuiltinESMExports();
      const pendingTimers = new Map<
        Parameters<typeof clearTimeout>[0],
        {
          settled: Promise<void>;
          finish: () => void;
          delayMs: number | undefined;
          createdAt: number;
          stack: string | undefined;
        }
      >();
      captureFailure = () => {
        failureSnapshot = JSON.stringify({
          ancestor,
          phase,
          pendingTimers: Array.from(pendingTimers.values(), ({ delayMs, createdAt, stack }) => ({
            delayMs,
            ageMs: Math.round(performance.now() - createdAt),
            stack,
          })),
          watchers: observed.map(({ watcher, ready, paths }) => ({
            paths,
            ready,
            closed: watcher.closed,
          })),
          watcherErrors: watcherErrors.map((error) =>
            error instanceof Error ? error.stack : String(error),
          ),
          nativeHandles,
        });
      };
      onTestFailed(() => {
        console.error(`[skills ancestor failure before cleanup] ${failureSnapshot}`);
      });
      const root = await fs.realpath(roots.make("skills-shared-ancestor-"));
      const source = (name: string) => {
        const sourceRoot = path.join(root, name, "nested", "skills");
        return {
          workspaceDir: path.join(root, `workspace-${name}`),
          sourceRoot,
          config: { skills: { load: { extraDirs: [sourceRoot] } } },
        };
      };
      const first = source("left");
      const second = source("right");
      for (const current of [first, second]) {
        phase = `create workspace: ${current.workspaceDir}`;
        await fs.mkdir(path.join(current.workspaceDir, "skills"), { recursive: true });
      }
      phase = "import refresh owner";
      const { ensureSkillsWatcher, closeSkillsWatchers, registerSkillsChangeListener } =
        await import("./refresh.js");
      phase = "import skill loader";
      const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
      const originalWatch = chokidar.watch;
      const watch = vi.spyOn(chokidar, "watch").mockImplementation((...args) => {
        const watcher = originalWatch(...args);
        const observation = { watcher, ready: false, paths: args[0] };
        observed.push(observation);
        // Attach before returning: promotion can create more watchers during ready.
        watcher.once("ready", () => {
          observation.ready = true;
        });
        watcher.on("error", (error) => watcherErrors.push(error));
        return watcher;
      });
      const originalSetTimeout = globalThis.setTimeout;
      const originalClearTimeout = globalThis.clearTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
        const { promise: settled, resolve: finish } = createDeferredCore();
        const timer = originalSetTimeout(() => {
          pendingTimers.delete(timer);
          try {
            callback.apply(timer, args);
          } finally {
            finish();
          }
        }, delay);
        pendingTimers.set(timer, {
          settled,
          finish,
          delayMs: delay,
          createdAt: performance.now(),
          stack: new Error("Watcher fixture timer created").stack,
        });
        return timer;
      });
      vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
        originalClearTimeout(timer);
        pendingTimers.get(timer)?.finish();
        pendingTimers.delete(timer);
      });
      const settleWatchers = async (stage: string) => {
        for (;;) {
          // Native registration is synchronous; its ready/reconciliation callbacks
          // are microtasks. Finish those before inspecting recursive scan readiness.
          await Promise.resolve();
          phase = `${stage}: wait for watcher readiness`;
          await vi.waitFor(() => {
            expect(watcherErrors).toEqual([]);
            expect(observed.every(({ watcher, ready }) => ready || watcher.closed)).toBe(true);
          });
          const generationCount = observed.length;
          // Drain actual debounce/stability work, including timers chained by its
          // continuations. Keep native time and watchers; do not sleep past a guess.
          phase = `${stage}: drain pending timers`;
          await Promise.all(Array.from(pendingTimers.values(), ({ settled }) => settled));
          phase = `${stage}: wait for immediate continuations`;
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          phase = `${stage}: check settled generation`;
          expect(watcherErrors).toEqual([]);
          if (
            pendingTimers.size === 0 &&
            observed.length === generationCount &&
            observed.every(({ watcher, ready }) => ready || watcher.closed)
          ) {
            return;
          }
        }
      };
      phase = "acquire watchers";
      for (const current of [first, second]) {
        ensureSkillsWatcher(current);
      }
      await settleWatchers("initial acquisition");
      if (nativeAncestor) {
        expect(nativeWatch.mock.calls.filter(([watched]) => watched === root)).toHaveLength(1);
      } else {
        expect(
          watch.mock.calls.filter(([watched]) => watched === root.replaceAll("\\", "/")),
        ).toHaveLength(1);
      }
      const changes: string[] = [];
      const unregister = registerSkillsChangeListener((event) => {
        if (event.workspaceDir) {
          changes.push(event.workspaceDir);
        }
      });
      const read = (current: typeof first) =>
        loadWorkspaceSkills(current.workspaceDir, {
          config: current.config,
          bundledSkillsDir: "",
          managedSkillsDir: path.join(root, "unused"),
        }).map((entry) => entry.skill.name);
      const writeSkill = async (current: typeof first, name: string) => {
        const directory = path.join(current.sourceRoot, name);
        phase = `create skill directory: ${name}`;
        await fs.mkdir(directory, { recursive: true });
        phase = `write skill: ${name}`;
        await fs.writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: Shared ancestor proof\n---\n`,
        );
      };
      try {
        phase = "prime empty discovery";
        expect(read(first)).toEqual([]);
        expect(read(second)).toEqual([]);
        const unrelatedFile = path.join(root, "unrelated.sqlite-wal");
        const lstat = vi.spyOn(fs, "lstat");
        syncBuiltinESMExports();
        try {
          phase = "write unrelated file";
          await fs.writeFile(unrelatedFile, "unrelated");
          await writeSkill(first, "first-proof");
          phase = "discover first skill";
          await expect.poll(() => read(first), { timeout: 3_000 }).toContain("first-proof");
          await settleWatchers("first discovery");
          if (nativeAncestor) {
            expect(lstat.mock.calls.filter(([file]) => file === unrelatedFile)).toEqual([]);
          }
        } finally {
          lstat.mockRestore();
          syncBuiltinESMExports();
        }
        expect(changes).not.toContain(second.workspaceDir);
        phase = "wait for root promotion";
        await vi.waitFor(() => {
          expect(
            watch.mock.calls.some(
              ([watched], index) =>
                watched === first.sourceRoot.replaceAll("\\", "/") &&
                observed[index]?.ready &&
                !observed[index]?.watcher.closed,
            ),
          ).toBe(true);
        });
        await settleWatchers("promoted root");
        // Prime after promoted root/companion scans and queued refreshes settle:
        // late initial reconciliation must not mask a missed ancestor move.
        expect(read(first)).toContain("first-proof");
        const movedAncestor =
          ancestor === "higher" ? path.join(root, "left") : path.join(root, "left", "nested");
        if (process.platform === "win32") {
          // Windows cannot rename an ancestor with live descendant directory watches.
          phase = "remove watched ancestor";
          await fs.rm(movedAncestor, { recursive: true });
        } else {
          phase = "rename watched ancestor";
          await fs.rename(movedAncestor, `${movedAncestor}-away`);
        }
        phase = "discover removed ancestor";
        await expect.poll(() => read(first), { timeout: 3_000 }).toEqual([]);
        await writeSkill(first, "returned-proof");
        phase = "discover returned skill";
        await expect.poll(() => read(first), { timeout: 3_000 }).toEqual(["returned-proof"]);
        await settleWatchers("recreated root");
        expect(read(first)).toEqual(["returned-proof"]);
        if (nativeAncestor) {
          phase = "replace ancestor at the same path before native delivery";
          nativeFs.renameSync(movedAncestor, `${movedAncestor}-replaced`);
          const replacementSkill = path.join(first.sourceRoot, "replacement-proof");
          nativeFs.mkdirSync(replacementSkill, { recursive: true });
          nativeFs.writeFileSync(
            path.join(replacementSkill, "SKILL.md"),
            "---\nname: replacement-proof\ndescription: Replaced ancestor\n---\n",
          );
          await expect.poll(() => read(first), { timeout: 3_000 }).toEqual(["replacement-proof"]);
          await settleWatchers("same-path replacement");
          // A one-time cache invalidation is insufficient: subsequent writes must
          // reach a content watcher registered on the replacement directory.
          await writeSkill(first, "replacement-later-proof");
          await expect
            .poll(() => read(first), { timeout: 3_000 })
            .toContain("replacement-later-proof");
        }
        // Retiring one logical workspace must not retire the shared missing-root observer.
        phase = "retire first workspace";
        ensureSkillsWatcher({
          workspaceDir: first.workspaceDir,
          config: { skills: { load: { watch: false } } },
        });
        await writeSkill(second, "remaining-proof");
        phase = "discover sibling skill";
        await expect.poll(() => read(second), { timeout: 3_000 }).toContain("remaining-proof");
        const skillFile = path.join(second.sourceRoot, "remaining-proof", "SKILL.md");
        const renamedSkillFile = path.join(second.sourceRoot, "remaining-proof", "SKILL.saved");
        phase = "rename sibling skill away";
        await fs.rename(skillFile, renamedSkillFile);
        phase = "discover renamed sibling skill absence";
        await expect.poll(() => read(second), { timeout: 3_000 }).toEqual([]);
        phase = "restore sibling skill filename";
        await fs.rename(renamedSkillFile, skillFile);
        phase = "discover restored sibling skill";
        await expect.poll(() => read(second), { timeout: 3_000 }).toContain("remaining-proof");
        phase = "remove sibling ancestor";
        await fs.rm(path.join(root, "right"), { recursive: true });
        phase = "discover removed sibling ancestor";
        await expect.poll(() => read(second), { timeout: 3_000 }).toEqual([]);
        await writeSkill(second, "recreated-proof");
        phase = "discover recreated sibling skill";
        await expect.poll(() => read(second), { timeout: 3_000 }).toContain("recreated-proof");
      } finally {
        unregister();
        await closeSkillsWatchers(true);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (nativeAncestor) {
          expect(nativeHandles.every(({ closed }) => closed)).toBe(true);
        }
      }
    },
  );

  it.runIf(process.platform !== "win32").each([
    {
      name: "does not promote missing roots through newly created ancestor symlinks",
      replaceAncestor: false,
    },
    {
      name: "rediscovers ordinary roots after a watched ancestor is replaced by a symlink",
      replaceAncestor: true,
    },
  ])("$name", async ({ replaceAncestor }) => {
    const root = await fs.realpath(roots.make("skills-ancestor-symlink-"));
    const outside = await fs.realpath(roots.make("skills-ancestor-outside-"));
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
    const link = path.join(root, "missing");
    const sourceRoot = path.join(link, "nested", "skills");
    if (replaceAncestor) {
      await fs.mkdir(link);
    }
    await fs.mkdir(path.join(outside, "nested", "skills", "outside-proof"), { recursive: true });
    const config = { skills: { load: { extraDirs: [sourceRoot] } } };
    const pollingRawPaths: string[] = [];
    let pollingRawDeliveries = 0;
    const unwatchedDuringPollingRaw: string[] = [];
    const originalUnwatchFile = nativeFs.unwatchFile;
    vi.spyOn(nativeFs, "unwatchFile").mockImplementation((...args) => {
      const unwatched = path.resolve(String(args[0]));
      if (pollingRawPaths.includes(unwatched)) {
        unwatchedDuringPollingRaw.push(unwatched);
      }
      return originalUnwatchFile(...args);
    });
    const originalWatch = chokidar.watch;
    const watch = vi.spyOn(chokidar, "watch").mockImplementation((...args) => {
      const watcher = originalWatch(...args);
      if (resolveSkillsWatcherUsePolling()) {
        const originalEmit = watcher.emit.bind(watcher);
        vi.spyOn(watcher, "emit").mockImplementation((...emitArgs) => {
          if (emitArgs[0] !== "raw") {
            return originalEmit(...emitArgs);
          }
          pollingRawPaths.push(path.resolve(String(emitArgs[2])));
          pollingRawDeliveries += 1;
          try {
            return originalEmit(...emitArgs);
          } finally {
            pollingRawPaths.pop();
          }
        });
      }
      return watcher;
    });
    const nativeWatch = vi.spyOn(nativeFs, "watch");
    syncBuiltinESMExports();
    const { ensureSkillsWatcher } = await import("./refresh.js");
    const { getSkillsSourceVersion } = await import("./refresh-state.js");
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const read = () =>
      loadWorkspaceSkills(workspaceDir, {
        config,
        bundledSkillsDir: "",
        managedSkillsDir: path.join(root, "unused"),
      }).map((entry) => entry.skill.name);
    ensureSkillsWatcher({ workspaceDir, config });
    expect(read()).toEqual([]);
    await Promise.all(
      watch.mock.results.map((result) => {
        if (result.type !== "return") {
          throw new Error("Watcher acquisition failed");
        }
        return new Promise<void>((resolve, reject) => {
          result.value.once("ready", resolve);
          result.value.once("error", reject);
        });
      }),
    );
    // Ready handlers reconcile synchronously before these promises resolve.
    // Unchanged empty inventory suppresses public events, but discovery still invalidates.
    const sourceVersion = getSkillsSourceVersion(workspaceDir);
    const chokidarAdmissionStart = replaceAncestor ? watch.mock.calls.length : 0;
    const nativeAdmissionStart = replaceAncestor ? nativeWatch.mock.calls.length : 0;
    if (replaceAncestor) {
      // Finish replacement in this turn so delivery cannot rely on observing
      // the intermediate absence before the same path becomes a symlink.
      nativeFs.renameSync(link, `${link}-away`);
      nativeFs.symlinkSync(outside, link, "dir");
    } else {
      await fs.symlink(outside, link, "dir");
    }
    await expect
      .poll(() => getSkillsSourceVersion(workspaceDir), { timeout: 3_000 })
      .toBeGreaterThan(sourceVersion);
    expect(
      watch.mock.calls
        .slice(chokidarAdmissionStart)
        .some(
          ([watched]) =>
            typeof watched === "string" && (watched === link || watched.startsWith(`${link}/`)),
        ),
    ).toBe(false);
    if (
      process.platform === "linux" &&
      !process.versions.bun &&
      !resolveSkillsWatcherUsePolling()
    ) {
      expect(
        nativeWatch.mock.calls.some(([watched]) => watched === (replaceAncestor ? link : root)),
      ).toBe(true);
      expect(
        nativeWatch.mock.calls
          .slice(nativeAdmissionStart)
          .some(
            ([watched]) =>
              typeof watched === "string" && (watched === link || watched.startsWith(`${link}/`)),
          ),
      ).toBe(false);
    }
    await fs.unlink(link);
    const skillDir = path.join(sourceRoot, "ordinary-proof");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: ordinary-proof\ndescription: Ordinary replacement\n---\n",
    );
    await expect.poll(read, { timeout: 3_000 }).toContain("ordinary-proof");
    if (resolveSkillsWatcherUsePolling()) {
      // watchFile still reads its listener container after synchronous raw delivery.
      expect(pollingRawDeliveries).toBeGreaterThan(0);
      expect(unwatchedDuringPollingRaw).toEqual([]);
    }
  });
});
