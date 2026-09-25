import { AsyncLocalStorage } from "node:async_hooks";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import * as ancestorOwner from "./refresh-ancestor-watch.js";
import * as nativeContentOwner from "./refresh-content-native.js";
import { resolveSkillsWatcherUsePolling } from "./refresh-watch-path.js";
import { shouldUseNativeSkillsWatcher } from "./refresh-watch-transport.js";
import type { SkillsDirectoryWatcher } from "./refresh-watch-types.js";
import {
  observeContentWatchers,
  type ObservedSkillsWatcher,
} from "./refresh.native.test-support.js";

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

describe("shared missing skill ancestors", () => {
  const roots = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      const { closeSkillsWatchers } = await import("./refresh.js");
      await closeSkillsWatchers(true);
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      cleanup();
    }),
  );

  const proveNativeSourceChange = async (
    kind:
      | "alias peer"
      | "named change"
      | "short rename"
      | "short change"
      | "existing root"
      | "parent ABA",
  ) => {
    const shortName = kind === "short rename" || kind === "short change";
    const existingRoot = kind === "existing root";
    const parentAba = kind === "parent ABA";
    const root = await fs.realpath(roots.make("skills-native-source-event-"));
    const workspaceDir = path.join(root, "workspace");
    const aliasWorkspaceDir = path.join(root, "alias-workspace");
    const sourceParent = path.join(root, "source");
    const parentA = path.join(root, "parent-a");
    const parentB = path.join(root, "parent-b");
    const sourceLink = path.join(
      sourceParent,
      shortName || existingRoot ? "long-skills-root" : "link",
    );
    const aliasTarget = path.join(sourceParent, "LONG-S~1");
    const firstTarget = path.join(root, "first-target");
    const nextTarget = path.join(root, "next-target");
    const firstSkill = path.join(firstTarget, "before-proof");
    const nextSkill = path.join(nextTarget, "after-proof");
    const peerAlias = path.join(root, "peer-alias");
    const skill = (name: string, description: string) =>
      `---\nname: ${name}\ndescription: ${description}\n---\n`;
    for (const directory of [
      path.join(workspaceDir, "skills"),
      sourceParent,
      firstSkill,
      nextSkill,
      path.join(firstTarget, "skills"),
      path.join(nextTarget, "skills"),
      ...(shortName ? [path.join(aliasWorkspaceDir, "skills")] : []),
    ]) {
      await fs.mkdir(directory, { recursive: true });
    }
    await fs.writeFile(path.join(firstSkill, "SKILL.md"), skill("before-proof", "before"));
    await fs.writeFile(path.join(nextSkill, "SKILL.md"), skill("after-proof", "replacement"));
    const linkType = process.platform === "win32" ? "junction" : "dir";
    if (!shortName) {
      await fs.symlink(firstTarget, sourceLink, linkType);
    }
    if (kind === "alias peer") {
      await fs.symlink(sourceParent, peerAlias, linkType);
    }
    const config = {
      skills: {
        load: {
          extraDirs: [sourceLink],
          allowSymlinkTargets: [firstTarget, nextTarget],
        },
      },
    };
    const options = { config, bundledSkillsDir: "", managedSkillsDir: path.join(root, "unused") };
    const sourcePlan = resolveWorkspaceSkillSourcePlan(workspaceDir, options);
    const { ensureSkillsWatcher, closeSkillsWatchers } = await import("./refresh.js");
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const read = () =>
      loadWorkspaceSkills(workspaceDir, options).map((entry) => entry.skill.description);
    if (parentAba) {
      // Establish supported loader admission before the watcher race is armed.
      expect(read()).toEqual(["before"]);
    }
    const observed: ObservedSkillsWatcher[] = [];
    const errors: unknown[] = [];
    const canonicalChanges: Array<[string, string]> = [];
    const contentSpy = observeContentWatchers(
      observed,
      errors,
      existingRoot ? canonicalChanges : undefined,
    );
    const generationContext = new AsyncLocalStorage<number>();
    const nativeContentWatchers: SkillsDirectoryWatcher[] = [];
    const nativeGenerations: ReturnType<
      typeof nativeContentOwner.createNativeSkillsContentWatcher
    >[] = [];
    const createNativeContent = nativeContentOwner.createNativeSkillsContentWatcher;
    const nativeContentSpy = parentAba
      ? vi
          .spyOn(nativeContentOwner, "createNativeSkillsContentWatcher")
          .mockImplementation((...args) => {
            const create = () => {
              const watcher = createNativeContent(...args);
              nativeContentWatchers.push(watcher);
              return watcher;
            };
            if (path.resolve(args[0]) !== sourceLink) {
              return create();
            }
            // The second generation verifies an already observing owner. Only its
            // admission races; its target stays intact throughout the parent moves.
            return generationContext.run(nativeGenerations.length, () => {
              const watcher = create();
              nativeGenerations.push(watcher);
              return watcher;
            });
          })
      : undefined;
    const originalStat = nativeFs.statSync;
    const originalLstat = nativeFs.lstatSync;
    let parentBIdentity: nativeFs.BigIntStats | undefined;
    const targetIdentity = parentAba ? originalStat(firstTarget, { bigint: true }) : undefined;
    let scannerParent: nativeFs.BigIntStats | undefined;
    let restoredParent = false;
    const statSpy = parentAba
      ? vi.spyOn(nativeFs, "statSync").mockImplementation((...args) => {
          const identity = originalStat(...args);
          if (
            generationContext.getStore() === 1 &&
            path.resolve(String(args[0])) === sourceParent &&
            typeof identity?.ino === "bigint" &&
            !scannerParent
          ) {
            scannerParent = identity as nativeFs.BigIntStats;
            nativeFs.renameSync(sourceParent, parentA);
            nativeFs.mkdirSync(sourceParent);
            nativeFs.symlinkSync(firstTarget, sourceLink, linkType);
            parentBIdentity = originalStat(sourceParent, { bigint: true });
          }
          return identity;
        })
      : undefined;
    const lstatSpy = parentAba
      ? vi.spyOn(nativeFs, "lstatSync").mockImplementation((...args) => {
          if (
            generationContext.getStore() === 1 &&
            path.resolve(String(args[0])) === sourceLink &&
            scannerParent &&
            !restoredParent
          ) {
            // The native before/watch/after bracket has already admitted B.
            // Restore physical A before reading its unchanged symbolic leaf.
            restoredParent = true;
            nativeFs.renameSync(sourceParent, parentB);
            nativeFs.renameSync(parentA, sourceParent);
          }
          return originalLstat(...args);
        })
      : undefined;
    const subscriptions: Parameters<typeof ancestorOwner.acquireSkillsAncestorWatcher>[2][] = [];
    const acquireAncestor = ancestorOwner.acquireSkillsAncestorWatcher;
    const ancestorSpy = vi
      .spyOn(ancestorOwner, "acquireSkillsAncestorWatcher")
      .mockImplementation((...args) => {
        if (parentAba || path.resolve(args[0]) === sourceParent) {
          subscriptions.push(args[2]);
        }
        return acquireAncestor(...args);
      });
    const handles: Array<{
      directory: string;
      closed: boolean;
      deliver: (event: nativeFs.WatchEventType, filename: string | null) => void;
      events: Array<{ event: string; filename: string }>;
      generation?: number;
      identity?: nativeFs.BigIntStats;
    }> = [];
    const originalWatch = nativeFs.watch;
    const nativeSpy = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
      const deliver = args[1];
      if (typeof deliver !== "function") {
        throw new Error("Expected a shallow native callback");
      }
      const directory = path.resolve(String(args[0]));
      const observation = {
        directory,
        closed: false,
        deliver,
        events: [] as (typeof handles)[number]["events"],
        generation: generationContext.getStore(),
        identity:
          parentAba && directory === sourceParent
            ? originalStat(sourceParent, { bigint: true })
            : undefined,
      };
      const native = originalWatch(args[0], (event, filename) => {
        observation.events.push({ event, filename: String(filename) });
        // Windows does not report a watched directory's own move. Suppress only
        // that Linux callback spelling; all real leaf events still flow normally.
        if (
          parentAba &&
          directory === sourceParent &&
          event === "rename" &&
          String(filename) === path.basename(sourceParent)
        ) {
          return;
        }
        if (parentAba || kind === "alias peer" || (!existingRoot && directory !== sourceParent)) {
          deliver(event, filename);
        }
      });
      native.once("close", () => {
        observation.closed = true;
      });
      native.on("error", (error) => {
        observation.closed = true;
        errors.push(error);
      });
      handles.push(observation);
      return native;
    });
    syncBuiltinESMExports();
    const timers = new Map<
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
          timers.delete(timer);
          try {
            callback.apply(timer, args);
          } finally {
            finish();
          }
        }, delay);
        timers.set(timer, { settled, finish });
        return timer;
      });
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
      originalClearTimeout(timer);
      timers.get(timer)?.finish();
      timers.delete(timer);
    });
    const settle = async (allowErrors = false) => {
      for (;;) {
        await vi.waitFor(() => {
          expect(observed.length).toBeGreaterThan(0);
          expect(observed.every(({ ready, watcher }) => ready || watcher.closed)).toBe(true);
          if (!allowErrors) {
            expect(errors).toEqual([]);
          }
        });
        const count = observed.length;
        await Promise.all(Array.from(timers.values(), ({ settled }) => settled));
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (
          timers.size === 0 &&
          count === observed.length &&
          observed.every(({ ready, watcher }) => ready || watcher.closed)
        ) {
          return;
        }
      }
    };
    let peer: nativeFs.FSWatcher | undefined;
    const peerRetired = createDeferredCore();
    try {
      if (kind === "alias peer") {
        // The external alias must own the first inotify path spelling. The
        // Skills observer below uses the canonical parent, never this alias.
        peer = nativeFs.watch(peerAlias, () => {});
        peer.once("close", () => peerRetired.resolve());
        peer.once("error", () => peerRetired.resolve());
        expect(handles.map(({ directory }) => directory)).toEqual([peerAlias]);
      }
      ensureSkillsWatcher({ workspaceDir, config, sourcePlan });
      if (shortName) {
        const aliasConfig = { skills: { load: { extraDirs: [aliasTarget] } } };
        ensureSkillsWatcher({
          workspaceDir: aliasWorkspaceDir,
          config: aliasConfig,
          sourcePlan: resolveWorkspaceSkillSourcePlan(aliasWorkspaceDir, {
            ...options,
            config: aliasConfig,
          }),
        });
      }
      await settle();
      expect(read()).toEqual(shortName ? [] : ["before"]);
      const parentRegistrationCount = handles.filter(
        ({ directory }) => directory === sourceParent,
      ).length;
      const initialObservers = handles.filter(
        ({ directory, closed }) => directory === sourceParent && !closed,
      );
      // Existing companion roots prevent a missing-root ancestor from masking
      // the logical entry-parent observer's own replacement notification.
      expect(initialObservers).toHaveLength(1);
      const initial = initialObservers[0]!;
      if (parentAba) {
        const identity = (value: nativeFs.BigIntStats) => [value.dev, value.ino];
        expect(scannerParent).toBeDefined();
        expect(restoredParent).toBe(true);
        expect(identity(scannerParent!)).toEqual(
          identity(originalStat(sourceParent, { bigint: true })),
        );
        expect(identity(scannerParent!)).not.toEqual(identity(parentBIdentity!));
        expect(nativeGenerations).toHaveLength(2);
        expect(nativeGenerations[0]!.closed).toBe(true);
        expect(nativeGenerations[1]!.closed).toBe(false);
        expect(observed.find(({ watcher }) => watcher === nativeGenerations[1])?.ready).toBe(true);
        const firstObserver = handles.find(
          ({ directory, generation }) => directory === sourceParent && generation === 0,
        );
        expect(identity(firstObserver!.identity!)).toEqual(identity(scannerParent!));
        await expect.poll(() => firstObserver!.closed, { timeout: 3_000 }).toBe(true);
        expect(
          handles.some(
            ({ directory, generation, identity: admitted }) =>
              directory === sourceParent &&
              generation === 1 &&
              admitted?.dev === parentBIdentity!.dev &&
              admitted.ino === parentBIdentity!.ino,
          ),
        ).toBe(true);
        expect(
          subscriptions.filter(({ path: target }) =>
            [sourceLink, path.join(sourceLink, "skills")].includes(path.resolve(target)),
          ),
        ).toEqual([]);
        expect(initial.generation).toBe(1);
        const witnessEvents: Array<{ event: string; filename: string }> = [];
        // This independent handle only witnesses the real mutation. It never
        // forwards an event to Skills or repairs the verifier's coverage.
        peer = nativeFs.watch(sourceParent, (event, filename) => {
          witnessEvents.push({ event, filename: String(filename) });
        });
        peer.once("close", () => peerRetired.resolve());
        peer.once("error", () => peerRetired.resolve());
        await settle();
        expect(read()).toEqual(["before"]);
        const reconcile = async (present: boolean) => {
          const before = witnessEvents.length;
          if (present) {
            nativeFs.symlinkSync(firstTarget, sourceLink, linkType);
          } else {
            nativeFs.unlinkSync(sourceLink);
          }
          await expect
            .poll(() => witnessEvents.slice(before), { timeout: 3_000 })
            .toContainEqual({ event: "rename", filename: path.basename(sourceLink) });
        };
        const observerEventOffset = initial.events.length;
        await reconcile(false);
        let lastCached: string[] = [];
        try {
          // Independent native callbacks can arrive in different turns. Give
          // Skills its normal deadline; only stale cached content is the control.
          await expect
            .poll(
              () => {
                lastCached = read();
                return lastCached.length;
              },
              { timeout: 3_000 },
            )
            .toBe(0);
        } catch (error) {
          expect(lastCached).toEqual(["before"]);
          expect(witnessEvents).toContainEqual({
            event: "rename",
            filename: path.basename(sourceLink),
          });
          expect(errors).toEqual([]);
          expect(identity(originalStat(sourceParent, { bigint: true }))).toEqual(
            identity(scannerParent!),
          );
          expect(identity(originalStat(firstTarget, { bigint: true }))).toEqual(
            identity(targetIdentity!),
          );
          expect(nativeFs.readFileSync(path.join(firstSkill, "SKILL.md"), "utf8")).toBe(
            skill("before-proof", "before"),
          );
          throw error;
        }
        expect(lastCached).toEqual([]);
        // Raw root reconciliation can close this content owner before its scan
        // emits an inventory event. Require the real observing handle's callback.
        expect(initial.events.slice(observerEventOffset)).toContainEqual({
          event: "rename",
          filename: path.basename(sourceLink),
        });
        await settle();
        await reconcile(true);
        await expect.poll(read, { timeout: 3_000 }).toEqual(["before"]);
        await settle();
        await reconcile(false);
        await expect.poll(read, { timeout: 3_000 }).toEqual([]);
        await settle();
        expect(identity(originalStat(sourceParent, { bigint: true }))).toEqual(
          identity(scannerParent!),
        );
        expect(identity(originalStat(parentB, { bigint: true }))).toEqual(
          identity(parentBIdentity!),
        );
        expect(identity(originalStat(firstTarget, { bigint: true }))).toEqual(
          identity(targetIdentity!),
        );
        expect(errors).toEqual([]);
        return;
      }
      const deliverWindows = (event: nativeFs.WatchEventType, filename: string) => {
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        try {
          // Real junction mutations, injected callback contract only; this
          // does not claim an NTFS short-name or FSCTL execution.
          Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
          initial.deliver(event, filename);
        } finally {
          Object.defineProperty(process, "platform", platform);
        }
      };
      if (existingRoot) {
        const reconcile = async (present: boolean) => {
          if (present) {
            nativeFs.symlinkSync(firstTarget, sourceLink, linkType);
          } else {
            nativeFs.unlinkSync(sourceLink);
          }
          deliverWindows("rename", path.basename(aliasTarget));
          // Check errors after the cache sequence: a first unavailable notice
          // must not mask stale discovery on the second removal in the control.
          await settle(true);
        };
        await reconcile(false);
        expect(read()).toEqual([]);
        await reconcile(true);
        expect(read()).toEqual(["before"]);
        await reconcile(false);
        const cached = read();
        expect(cached.length).toBe(0);
        expect(cached).toEqual([]);
        const normalizedLink = sourceLink.replaceAll("\\", "/");
        expect(
          canonicalChanges.filter(([, changedPath]) => changedPath === normalizedLink),
        ).toEqual([
          ["unlink", normalizedLink],
          ["add", normalizedLink],
          ["unlink", normalizedLink],
        ]);
        expect(initial.closed).toBe(false);
        expect(handles.filter(({ directory }) => directory === sourceParent)).toHaveLength(
          parentRegistrationCount,
        );
        expect(errors).toEqual([]);
        return;
      }
      if (shortName) {
        // A separate workspace admits the short spelling into the shared
        // observer. Its invalidation cannot refresh this workspace's cache.
        expect(
          subscriptions
            .find(({ path: target }) => path.resolve(target) === sourceLink)
            ?.ignored(aliasTarget),
        ).toBe(true);
        expect(
          subscriptions
            .find(({ path: target }) => path.resolve(target) === aliasTarget)
            ?.ignored(aliasTarget),
        ).toBe(false);
        const sibling = handles.find(
          ({ directory, closed }) =>
            directory === path.join(aliasWorkspaceDir, "skills") && !closed,
        );
        expect(sibling).toBeDefined();
        nativeFs.symlinkSync(firstTarget, sourceLink, linkType);
        deliverWindows("rename", path.basename(sourceLink));
        await expect.poll(read, { timeout: 3_000 }).toEqual(["before"]);
        await settle();
        expect(read()).toEqual(["before"]);
        // Promotion stops at the new symlink. Only the shared parent observes
        // it; no content generation can hide a missed removal notification.
        expect(initial.closed).toBe(false);
        expect(handles.filter(({ directory }) => directory === sourceParent)).toHaveLength(1);
        expect(
          handles.some(({ directory }) => directory === sourceLink || directory === firstTarget),
        ).toBe(false);
        nativeFs.unlinkSync(sourceLink);
        deliverWindows(kind === "short rename" ? "rename" : "change", path.basename(aliasTarget));
        await expect.poll(read, { timeout: 3_000 }).toEqual([]);
        await settle();
        expect(read()).toEqual([]);
        expect(sibling!.closed).toBe(false);
        expect(errors).toEqual([]);
        return;
      }
      if (kind === "alias peer") {
        const previous = nativeFs.statSync(sourceParent, { bigint: true });
        nativeFs.renameSync(sourceParent, path.join(root, "retained-source"));
        nativeFs.mkdirSync(sourceParent);
        nativeFs.symlinkSync(nextTarget, sourceLink, linkType);
        expect(nativeFs.statSync(sourceParent, { bigint: true }).ino).not.toBe(previous.ino);
        await vi.waitFor(() =>
          expect(initial.events).toContainEqual({ event: "rename", filename: "peer-alias" }),
        );
      } else {
        // Hold native rename delivery and inject only the documented Windows
        // modified-entry callback after real retargeting; no FSCTL claim here.
        nativeFs.unlinkSync(sourceLink);
        nativeFs.symlinkSync(nextTarget, sourceLink, linkType);
        initial.deliver("change", path.basename(sourceLink));
      }
      await expect.poll(read, { timeout: 3_000 }).toEqual(["replacement"]);
      await settle();
      expect(read()).toEqual(["replacement"]);
      // Link events invalidate discovery immediately; preparation admits the
      // newly selected physical target before its later content edits.
      ensureSkillsWatcher({ workspaceDir, config, sourcePlan });
      await settle();
      for (const directory of [nextTarget, nextSkill]) {
        expect(handles.some((handle) => handle.directory === directory && !handle.closed)).toBe(
          true,
        );
      }
      expect(read()).toEqual(["replacement"]);
      await fs.writeFile(path.join(nextSkill, "SKILL.md"), skill("after-proof", "later deep edit"));
      await expect.poll(read, { timeout: 3_000 }).toEqual(["later deep edit"]);
      await settle();
      expect(read()).toEqual(["later deep edit"]);
      if (kind === "named change") {
        nativeFs.unlinkSync(sourceLink);
        const current = handles.findLast(
          ({ directory, closed }) => directory === sourceParent && !closed,
        );
        expect(current).toBeDefined();
        current!.deliver("rename", path.basename(sourceLink));
        await expect.poll(read, { timeout: 3_000 }).toEqual([]);
      } else {
        expect(handles[0]?.closed).toBe(false);
        expect(
          handles.filter(({ directory }) => directory === sourceParent).length,
        ).toBeGreaterThan(parentRegistrationCount);
      }
      expect(errors).toEqual([]);
    } finally {
      try {
        await closeSkillsWatchers(true);
        if (parentAba) {
          const results = await Promise.all(
            nativeContentWatchers.map((watcher) => watcher.close()),
          );
          expect(results).toEqual(results.map(() => ({ ok: true, value: undefined })));
          expect(errors).toEqual([]);
        }
      } finally {
        peer?.close();
        if (peer) {
          await peerRetired.promise;
        }
        contentSpy.mockRestore();
        nativeContentSpy?.mockRestore();
        statSpy?.mockRestore();
        lstatSpy?.mockRestore();
        ancestorSpy.mockRestore();
        nativeSpy.mockRestore();
        syncBuiltinESMExports();
        timeoutSpy.mockRestore();
        clearSpy.mockRestore();
      }
      expect(handles.every(({ closed }) => closed)).toBe(true);
      if (parentAba) {
        expect(errors).toEqual([]);
      }
    }
  };

  it.runIf(
    process.platform === "linux" && !process.versions.bun && !resolveSkillsWatcherUsePolling(),
  )("refreshes a replaced symbolic source when an earlier alias peer names the self-event", () =>
    proveNativeSourceChange("alias peer"),
  );

  it.runIf(shouldUseNativeSkillsWatcher(resolveSkillsWatcherUsePolling()))(
    "refreshes a retargeted symbolic source from only a named change and retains unlink relevance",
    () => proveNativeSourceChange("named change"),
  );

  it.runIf(shouldUseNativeSkillsWatcher(resolveSkillsWatcherUsePolling()))(
    "refreshes cached skills when a pending symbolic-root verifier admits an intermediate parent directory",
    () => proveNativeSourceChange("parent ABA"),
  );

  it.runIf(shouldUseNativeSkillsWatcher(resolveSkillsWatcherUsePolling()))(
    "refreshes cached skills after an admitted symbolic root is removed twice",
    () => proveNativeSourceChange("existing root"),
  );

  it
    .runIf(shouldUseNativeSkillsWatcher(resolveSkillsWatcherUsePolling()))
    .each(["short rename", "short change"] as const)(
    "refreshes a cached junction removal from %s when another subscription admits its alias",
    (kind) => proveNativeSourceChange(kind),
  );
});
