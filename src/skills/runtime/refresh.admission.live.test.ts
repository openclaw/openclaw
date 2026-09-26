import fs from "node:fs/promises";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe/root";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import type { WatchOptions, WatchScope, WatchSubscription } from "@openclaw/fs-safe/watch";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import * as refreshState from "./refresh-state.js";
import { toWatchRoot } from "./refresh-watch-path.js";
import { useSkillsWatcherFixture } from "./refresh.watcher.test-support.js";

const starts: Promise<void>[] = [];
let onWatchEvent: ((event: unknown) => void) | undefined;
let onSubscription:
  | ((root: Root, options: WatchOptions, subscription: WatchSubscription) => void)
  | undefined;
vi.mock("@openclaw/fs-safe/watch", async () => {
  const { createRequire } = await import("node:module");
  const actual = createRequire(import.meta.url)(
    "@openclaw/fs-safe/watch",
  ) as typeof import("@openclaw/fs-safe/watch");
  const watch: typeof actual.watch = (root, options) => {
    // Native delivery is the contract under test, not a periodic repair scan.
    const subscription = actual.watch(root, {
      ...options,
      intervalMs: 2_147_483_647,
      onInvalidate(invalidation) {
        onWatchEvent?.({
          kind: "invalidation",
          scopes: options.scopes.slice(0, 4),
          reason: invalidation.reason,
          changes: invalidation.changes?.slice(0, 8),
        });
        options.onInvalidate(invalidation);
      },
      onHealth(health) {
        onWatchEvent?.({
          kind: "health",
          state: health.state,
          mode: health.mode,
          directories: health.directories,
          failure: health.failure && {
            operation: health.failure.operation,
            code: health.failure.code,
          },
        });
        options.onHealth?.(health);
      },
    });
    starts.push(subscription.ready);
    onSubscription?.(root, options, subscription);
    return subscription;
  };
  return { ...actual, watch };
});
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));
const fixture = useSkillsWatcherFixture();
const outside = useAutoCleanupTempDirTracker(afterEach);
const refresh = await import("./refresh.js");
const source = await import("./refresh-observation-source.js");
const registry = await import("./refresh-watch-registry.js");
const nativeSupported =
  ["linux", "darwin", "win32"].includes(process.platform) &&
  !process.versions.bun &&
  !process.versions.deno;
beforeEach(() => {
  starts.length = 0;
  onSubscription = undefined;
  onWatchEvent = undefined;
});

it.skipIf(!nativeSupported)(
  "replans an entry replaced before first admission and observes a later native descendant edit",
  async () => {
    const workspaceDir = fixture.workspaceDir;
    const sourceRoot = path.join(workspaceDir, "skills");
    const sourceKey = toWatchRoot(sourceRoot);
    const linkedRoot = await fixture.createFixtureDirectory("linked-source");
    await fs.rm(sourceRoot, { recursive: true });
    await fs.symlink(linkedRoot, sourceRoot, process.platform === "win32" ? "junction" : "dir");
    const planned = createDeferredCore();
    const release = createDeferredCore();
    const rearmed = createDeferredCore<WatchSubscription>();
    const plan = source.skillsObservationScope;
    const logicalTargets = new WeakMap<WatchScope, string>();
    let held = false;
    let firstAuthority: Root | undefined;
    let replacementAuthority: Root | undefined;
    vi.spyOn(source, "skillsObservationScope").mockImplementation(async (...args) => {
      const scope = await plan(...args);
      logicalTargets.set(scope, args[1].path);
      if (!held && args[1].path === sourceKey && scope.kind === "entry") {
        held = true;
        planned.resolve();
        await release.promise;
      }
      return scope;
    });
    onSubscription = (root, options, subscription) => {
      if (!options.scopes.some((scope) => logicalTargets.get(scope) === sourceKey)) {
        return;
      }
      if (options.scopes[0]?.kind === "entry") {
        firstAuthority ??= root;
      } else if (firstAuthority) {
        replacementAuthority = root;
        rearmed.resolve(subscription);
      }
    };
    const read = () =>
      loadWorkspaceSkills(workspaceDir, { workspaceOnly: true }).map(
        (entry) => entry.skill.description,
      );
    const write = (description: string) =>
      writeSkill({ dir: path.join(sourceRoot, "guide"), name: "guide", description });
    expect(read()).toEqual([]);
    refresh.ensureSkillsWatcher({
      workspaceDir,
      sourcePlan: resolveWorkspaceSkillSourcePlan(workspaceDir, { workspaceOnly: true }),
    });
    let unsubscribe = () => {};
    try {
      await planned.promise;
      await fs.unlink(sourceRoot);
      await write("Replacement before registration");
      release.resolve();
      const replacement = await rearmed.promise;
      await replacement.ready;
      await Promise.resolve();
      expect(replacementAuthority).toBe(firstAuthority);
      expect(registry.pathWatchers.get(sourceKey)?.verified).toBe(true);
      expect(read()).toEqual(["Replacement before registration"]);
      const changed = createDeferredCore();
      unsubscribe = refresh.registerSkillsChangeListener((event) => {
        if (event.workspaceDir === workspaceDir && read().includes("Later native edit")) {
          changed.resolve();
        }
      });
      await write("Later native edit");
      await changed.promise;
      expect(read()).toEqual(["Later native edit"]);
    } finally {
      release.resolve();
      unsubscribe();
      await refresh.closeSkillsWatchers();
    }
  },
);

it.skipIf(!nativeSupported).each(["directory", "missing"] as const)(
  "discovers a %s-to-link startup target before availability and observes later native edits",
  async (initialKind) => {
    const workspaceDir = fixture.workspaceDir;
    const sourceRoot = path.join(workspaceDir, "skills");
    const sourceKey = toWatchRoot(sourceRoot);
    const companionKey = toWatchRoot(path.join(sourceRoot, "skills"));
    // No observation of the lexical source's authority can see target edits.
    const targetRoot = await fs.realpath(outside.make("skills-startup-target-"));
    const targetKey = toWatchRoot(targetRoot);
    const write = (description: string) =>
      writeSkill({ dir: path.join(targetRoot, "guide"), name: "guide", description });
    await write("Discovered at admission");
    if (initialKind === "missing") {
      await fs.rm(sourceRoot, { recursive: true });
    }
    const config = { skills: { load: { allowSymlinkTargets: [targetRoot] } } };
    const sourcePlan = resolveWorkspaceSkillSourcePlan(workspaceDir, {
      workspaceOnly: true,
      config,
    });
    // Keep the race on this source, not a sibling watcher discovering the link first.
    sourcePlan.roots = sourcePlan.roots.filter((root) => root.dir === sourceRoot);
    const params = { workspaceDir, config, sourcePlan };
    const watcherKey = JSON.stringify([workspaceDir, undefined, undefined]);
    const read = () =>
      loadWorkspaceSkills(workspaceDir, { config, workspaceOnly: true }).map(
        (entry) => entry.skill.description,
      );
    const planned = createDeferredCore();
    const release = createDeferredCore();
    const releaseCompanion = createDeferredCore();
    const targetPlanned = createDeferredCore();
    const releaseTarget = createDeferredCore();
    const lexicalStarted = createDeferredCore<WatchSubscription>();
    const available = createDeferredCore<{
      covered: boolean;
      targetVerified: boolean;
      observedDirectories: number;
    }>();
    const logicalTargets = new WeakMap<WatchScope, string>();
    const plan = source.skillsObservationScope;
    let lexicalAuthority: Root | undefined;
    let targetSubscription: WatchSubscription | undefined;
    vi.spyOn(source, "skillsObservationScope").mockImplementation(async (...args) => {
      const scope = await plan(...args);
      logicalTargets.set(scope, args[1].path);
      if (args[1].path === sourceKey) {
        expect(scope.kind).toBe("tree");
        planned.resolve();
        await release.promise;
      } else if (args[1].path === companionKey) {
        await releaseCompanion.promise;
      } else if (args[1].path === targetKey) {
        targetPlanned.resolve();
        await releaseTarget.promise;
      }
      return scope;
    });
    onSubscription = (root, options, subscription) => {
      const logicalPath = logicalTargets.get(options.scopes[0]!);
      if (logicalPath === sourceKey) {
        lexicalAuthority = root;
        lexicalStarted.resolve(subscription);
      } else if (logicalPath === targetKey) {
        targetSubscription = subscription;
      }
    };
    const events = vi.fn();
    const changed = createDeferredCore();
    const unsubscribe = refresh.registerSkillsChangeListener((event) => {
      if (event.workspaceDir !== workspaceDir) {
        return;
      }
      events(event);
      if (event.reason === "watch-available") {
        available.resolve({
          covered: registry.hasVerifiedCoverage(watcherKey),
          targetVerified: registry.pathWatchers.get(targetKey)?.verified === true,
          observedDirectories: targetSubscription?.health().directories ?? 0,
        });
      }
      if (event.reason === "watch" && read().includes("Later target edit")) {
        changed.resolve();
      }
    });
    try {
      expect(read()).toEqual([]);
      // Public recovery entry point enrolls the readiness waiter BEFORE the race.
      // No ensure/reconcile call after mutation may repair target discovery for us.
      expect(refresh.reconcileSkillsWatcherCoverage(params)).toBe(false);
      await planned.promise;
      if (initialKind === "directory") {
        await fs.rm(sourceRoot, { recursive: true });
      }
      await fs.symlink(targetRoot, sourceRoot, process.platform === "win32" ? "junction" : "dir");
      release.resolve();
      const lexical = await lexicalStarted.promise;
      await lexical.ready;
      await Promise.resolve();
      expect(lexical.health()).toMatchObject({ state: "ready", mode: "events" });
      // Assert before releasing any other source: the old handoff fails here,
      // rather than being rescued by another subscriber's startup/failure event.
      expect(registry.pathWatchers.has(targetKey)).toBe(true);
      await targetPlanned.promise;
      expect(registry.hasVerifiedCoverage(watcherKey)).toBe(false);
      expect(events.mock.calls.some(([event]) => event.reason === "watch-available")).toBe(false);
      expect(await registry.pathWatchers.get(sourceKey)?.authority).toBe(lexicalAuthority);
      releaseCompanion.resolve();
      releaseTarget.resolve();
      const admitted = await available.promise;
      expect(admitted.covered).toBe(true);
      expect(admitted.targetVerified).toBe(true);
      expect(admitted.observedDirectories).toBeGreaterThanOrEqual(2);
      expect(targetSubscription?.health()).toMatchObject({ state: "ready", mode: "events" });
      expect(read()).toEqual(["Discovered at admission"]);
      await write("Later target edit");
      await changed.promise;
      expect(read()).toEqual(["Later target edit"]);
    } finally {
      release.resolve();
      releaseCompanion.resolve();
      releaseTarget.resolve();
      unsubscribe();
      await refresh.closeSkillsWatchers();
    }
  },
);

it.skipIf(!nativeSupported)(
  "refreshes native supporting create, replacement and deletion without publishing parsed skills",
  async ({ onTestFailed }) => {
    let phase = "ready";
    const observations: unknown[] = [];
    const owned: WatchSubscription[] = [];
    onWatchEvent = (event) => {
      if (observations.length === 24) {
        observations.shift();
      }
      observations.push({ phase, event });
    };
    onSubscription = (_root, _options, subscription) => {
      if (owned.length < 16) {
        owned.push(subscription);
      }
    };
    onTestFailed(() => {
      console.error(
        JSON.stringify({
          owner: "skills",
          case: "supporting-files",
          platform: process.platform,
          phase,
          observations,
          health: owned.map((subscription) => {
            const health = subscription.health();
            return {
              state: health.state,
              mode: health.mode,
              directories: health.directories,
              failure: health.failure && {
                operation: health.failure.operation,
                code: health.failure.code,
              },
            };
          }),
        }),
      );
    });
    const workspaceDir = fixture.workspaceDir;
    const skillDir = path.join(workspaceDir, "skills", "guide");
    const targetWorkspaceDir = await fixture.createFixtureDirectory("sandbox");
    await writeSkill({ dir: skillDir, name: "guide", description: "Supporting resources" });
    await fs.mkdir(path.join(skillDir, "scripts"));
    const scriptPath = path.join(skillDir, "scripts", "run.sh");
    const planning: Promise<unknown>[] = [];
    const plan = source.skillsObservationScope;
    vi.spyOn(source, "skillsObservationScope").mockImplementation((...args) => {
      const work = plan(...args);
      planning.push(work);
      return work;
    });
    refresh.ensureSkillsWatcher({
      workspaceDir,
      sourcePlan: resolveWorkspaceSkillSourcePlan(workspaceDir, { workspaceOnly: true }),
    });
    await Promise.resolve();
    await Promise.all(
      [...registry.pathWatchers.values()].flatMap((state) =>
        state.authority ? [state.authority] : [],
      ),
    );
    await Promise.all(planning);
    await Promise.all(starts);
    phase = "imports";
    const { buildSkillSnapshot } = await import("../loading/workspace-skill-prompt.js");
    const { syncWorkspaceSkills } = await import("../loading/workspace-skill-sync.runtime.js");
    const loadOptions = {
      bundledSkillsDir: "",
      managedSkillsDir: path.join(workspaceDir, "missing-managed"),
    };
    phase = "snapshot";
    const skillsSnapshot = await buildSkillSnapshot(workspaceDir, loadOptions);
    const syncOptions = {
      sourceWorkspaceDir: workspaceDir,
      targetWorkspaceDir,
      skillsSnapshot,
      ...loadOptions,
    };
    phase = "initial-sync";
    await syncWorkspaceSkills(syncOptions);
    const copiedScript = path.join(targetWorkspaceDir, "skills", "guide", "scripts", "run.sh");
    const snapshotVersion = refreshState.getSkillsSnapshotVersion(workspaceDir);
    const changed = vi.fn();
    let supporting = createDeferredCore();
    let resourceVersion = refreshState.getSkillsResourceVersion(workspaceDir);
    const refreshed = (changedWorkspace?: string) => {
      if (
        changedWorkspace === workspaceDir &&
        refreshState.getSkillsResourceVersion(workspaceDir) > resourceVersion
      ) {
        supporting.resolve();
      }
    };
    const unsubscribe = refresh.registerSkillsChangeListener((event) => {
      changed(event);
      supporting.reject(new Error("Unexpected discovery publication: " + JSON.stringify(event)));
    });
    const markSupporting = refreshState.markSkillsSupportingFilesChanged;
    vi.spyOn(refreshState, "markSkillsSupportingFilesChanged").mockImplementation((params) => {
      markSupporting(params);
      refreshed(params.workspaceDir);
    });
    // Native directory hints can also advance resource freshness through
    // discovery reconciliation without changing the parsed skill fingerprint.
    const bumpSnapshot = refreshState.bumpSkillsSnapshotVersion;
    vi.spyOn(refreshState, "bumpSkillsSnapshotVersion").mockImplementation((params) => {
      const version = bumpSnapshot(params);
      refreshed(params?.workspaceDir);
      return version;
    });
    try {
      phase = "create";
      await fs.writeFile(scriptPath, "created");
      await supporting.promise;
      phase += "-sync";
      await syncWorkspaceSkills(syncOptions);
      expect(await fs.readFile(copiedScript, "utf8")).toBe("created");

      supporting = createDeferredCore();
      resourceVersion = refreshState.getSkillsResourceVersion(workspaceDir);
      phase = "replace";
      // Stay outside the admitted Root, not merely outside the selected source.
      // A vanished sibling under the watched Root is intentionally unknown detail.
      const replacement = path.join(outside.make("skills-atomic-source-"), "replacement-script");
      await fs.writeFile(replacement, "atomically replaced");
      await fs.rename(replacement, scriptPath);
      await supporting.promise;
      phase += "-sync";
      await syncWorkspaceSkills(syncOptions);
      expect(await fs.readFile(copiedScript, "utf8")).toBe("atomically replaced");

      supporting = createDeferredCore();
      resourceVersion = refreshState.getSkillsResourceVersion(workspaceDir);
      phase = "delete";
      await fs.unlink(scriptPath);
      await supporting.promise;
      phase += "-sync";
      await syncWorkspaceSkills(syncOptions);
      await expect(fs.stat(copiedScript)).rejects.toMatchObject({ code: "ENOENT" });
      expect(refreshState.getSkillsSnapshotVersion(workspaceDir)).toBe(snapshotVersion);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      await refresh.closeSkillsWatchers();
    }
  },
);

it.runIf(nativeSupported)(
  "joins a held native Skills scan without late availability or re-admission",
  async ({ signal }) => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const abort = () => release.resolve();
    signal.addEventListener("abort", abort, { once: true });
    const owned: WatchSubscription[] = [];
    onSubscription = (_root, _options, subscription) => {
      owned.push(subscription);
    };
    const events = vi.fn();
    const unsubscribe = refresh.registerSkillsChangeListener(events);
    let held = false;
    __setFsSafeTestHooksForTest({
      async beforeWatchRegistration() {
        if (held) {
          return;
        }
        held = true;
        entered.resolve();
        await release.promise;
      },
    });
    try {
      refresh.ensureSkillsWatcher({
        workspaceDir: fixture.workspaceDir,
        sourcePlan: resolveWorkspaceSkillSourcePlan(fixture.workspaceDir, { workspaceOnly: true }),
      });
      await entered.promise;
      const admitted = owned.length;
      const before = events.mock.calls.length;
      let joined = false;
      const closing = refresh.closeSkillsWatchers().then(() => {
        joined = true;
      });
      await Promise.resolve();
      expect(joined).toBe(false);
      __setFsSafeTestHooksForTest();
      release.resolve();
      await closing;
      expect(owned).toHaveLength(admitted);
      expect(owned.length).toBeGreaterThan(0);
      for (const subscription of owned) {
        expect(subscription.health()).toMatchObject({ state: "closed" });
      }
      expect(events).toHaveBeenCalledTimes(before);
    } finally {
      __setFsSafeTestHooksForTest();
      release.resolve();
      signal.removeEventListener("abort", abort);
      unsubscribe();
      await refresh.closeSkillsWatchers();
    }
  },
);
