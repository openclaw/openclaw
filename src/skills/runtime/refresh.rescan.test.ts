import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillSnapshot } from "../types.js";
import { getSkillsSnapshotVersion, getSkillsSourceVersion } from "./refresh-state.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";

const { createdWatchers, watchMock, nativeWatchMock, nativeContentWatchMock, watchForSkillRoot } =
  createSkillsWatcherMock();
vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("./refresh-ancestor-native.js", () => ({
  createNativeSkillsAncestorWatcher: nativeWatchMock,
}));
vi.mock("./refresh-content-native.js", () => ({
  createNativeSkillsContentWatcher: nativeContentWatchMock,
}));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

let refresh: typeof import("./refresh.js");
describe("skills content rescan handoff", () => {
  const fixture = useSkillsWatcherFixture();
  beforeAll(async () => {
    refresh = await import("./refresh.js");
  });
  beforeEach(() => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    watchMock.mockClear();
    createdWatchers.length = 0;
  });
  const acquire = () => {
    refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
    const root = path.join(fixture.workspaceDir, "skills");
    const active = watchForSkillRoot(root).watcher;
    for (const watcher of createdWatchers) {
      if (watcher !== active) {
        watcher.emit("ready");
      }
    }
    return { root, active };
  };
  const start = (phase: "initial" | "replacement" = "replacement") => {
    const { root, active: first } = acquire();
    if (phase === "initial") {
      first.emit("ready");
      return { root, active: first, pending: watchForSkillRoot(root).watcher };
    }
    for (const watcher of createdWatchers) {
      watcher.emit("ready");
    }
    const active = watchForSkillRoot(root).watcher;
    active.emit("all", "addDir", path.join(root, "first"));
    const pending = watchForSkillRoot(root).watcher;
    expect(pending).not.toBe(active);
    expect(active.closed).toBe(false);
    return { root, active, pending };
  };
  const acquirePromotedRoot = async (name: string) => {
    const ancestor = await fixture.createFixtureDirectory(name);
    const intermediate = path.join(ancestor, "nested");
    const root = path.join(intermediate, "skills");
    const params = {
      workspaceDir: fixture.workspaceDir,
      config: { skills: { load: { extraDirs: [root] } } },
      skillFilter: ["ancestor-proof"],
    };
    refresh.ensureSkillsWatcher(params);
    const initial = watchForSkillRoot(root).watcher;
    const write = (description: string) =>
      writeSkill({ dir: path.join(root, "ancestor-proof"), name: "ancestor-proof", description });
    await write("First preparation");
    initial.emit("ready");
    const content = watchForSkillRoot(root).watcher;
    const ancestorIndex = watchMock.mock.calls.findLastIndex(
      ([watched, options], index) =>
        watched === intermediate.replaceAll("\\", "/") &&
        options.depth === 0 &&
        !createdWatchers[index]?.closed,
    );
    expect(ancestorIndex).toBeGreaterThanOrEqual(0);
    const ancestorWatcher = createdWatchers[ancestorIndex]!;
    for (const watcher of createdWatchers) {
      if (watcher !== content && watcher !== ancestorWatcher) {
        watcher.emit("ready");
      }
    }
    await Promise.resolve();
    return { root, intermediate, params, write, content, ancestorWatcher };
  };

  it("publishes initial readiness only after a scan under continuous observation", () => {
    const { root, active } = acquire();
    const before = getSkillsSourceVersion(fixture.workspaceDir);
    active.emit("ready");
    const pending = watchForSkillRoot(root).watcher;
    expect(pending).not.toBe(active);
    expect(active.closed).toBe(false);
    expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(before);
    pending.emit("ready");
    expect(active.closed).toBe(true);
    expect(pending.closed).toBe(false);
    const ready = getSkillsSourceVersion(fixture.workspaceDir);
    expect(ready).toBeGreaterThan(before);
    pending.emit("ready");
    active.emit("ready");
    expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(ready);
  });

  it.each(["initial", "replacement"] as const)(
    "verifies every expanding directory inventory during %s coverage",
    (phase) => {
      const { root, active, pending } = start(phase);
      const before = getSkillsSourceVersion(fixture.workspaceDir);
      // The observer can discover these after its first ready. Its mutable
      // inventory cannot prove their watches predated the verifier's listing.
      const directories: Record<string, string[]> = { [root]: ["outer"] };
      active.getWatched.mockReturnValue(directories);
      pending.getWatched.mockReturnValue(directories);
      let observer = active;
      let verifier = pending;
      for (const directory of [root, path.join(root, "outer"), path.join(root, "outer", "inner")]) {
        directories[directory] = [];
        verifier.emit("ready");
        expect(observer.closed).toBe(true);
        expect(verifier.closed).toBe(false);
        expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(before);
        observer = verifier;
        verifier = watchForSkillRoot(root).watcher;
        expect(verifier).not.toBe(observer);
        verifier.getWatched.mockReturnValue(directories);
      }
      verifier.emit("ready");
      expect(observer.closed).toBe(true);
      expect(verifier.closed).toBe(false);
      expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(before);
      expect(active.getWatched).toHaveBeenCalledOnce();
      expect(pending.getWatched).toHaveBeenCalledOnce();
    },
  );

  it("recovers an initial verification error on the next real directory wave", () => {
    vi.useFakeTimers();
    const { root, active, pending } = start("initial");
    const before = getSkillsSourceVersion(fixture.workspaceDir);
    pending.emit("error", Object.assign(new Error("scan failed"), { code: "EIO" }));
    expect(active.closed).toBe(false);
    expect(pending.closed).toBe(true);
    const count = createdWatchers.length;
    const failed = getSkillsSourceVersion(fixture.workspaceDir);
    expect(failed).toBeGreaterThan(before);
    pending.emit("ready");
    expect(createdWatchers).toHaveLength(count);
    expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(failed);
    active.emit("all", "addDir", path.join(root, "second"));
    const recovery = watchForSkillRoot(root).watcher;
    expect(recovery).not.toBe(active);
    recovery.emit("ready");
    expect(active.closed).toBe(true);
    expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(failed);
  });

  it.each(
    (["initial", "replacement"] as const).flatMap((phase) =>
      (["workspace", "shared", "execution"] as const).map((scope) => ({ phase, scope })),
    ),
  )(
    "reconciles only affected $scope sources after a $phase verification error",
    async ({ phase, scope }) => {
      const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
      const workspaceDir = fixture.workspaceDir;
      const healthyWorkspace = await fixture.createFixtureDirectory("healthy-workspace");
      const sharedRoot = await fixture.createFixtureDirectory("shared/skills");
      const executionWorkspaceDir = await fixture.createFixtureDirectory("execution");
      const otherExecution = await fixture.createFixtureDirectory("other-execution");
      const config = scope === "shared" ? { skills: { load: { extraDirs: [sharedRoot] } } } : {};
      const root =
        scope === "shared"
          ? sharedRoot
          : path.join(scope === "execution" ? executionWorkspaceDir : workspaceDir, "skills");
      const write = (description: string) =>
        writeSkill({ dir: path.join(root, "scan-proof"), name: "scan-proof", description });
      await write("Original verified preparation");
      const request = {
        workspaceDir,
        config,
        ...(scope === "execution" ? { executionWorkspaceDir } : {}),
      };
      const affected = [
        request,
        ...(scope === "shared"
          ? [{ workspaceDir: await fixture.createFixtureDirectory("shared-subscriber"), config }]
          : []),
      ];
      const snapshots = new Map<string, SkillSnapshot>();
      const prepare = async (params: typeof request) => {
        const key = JSON.stringify(params);
        const { snapshot } = await resolveReusableWorkspaceSkillSnapshot({
          ...params,
          existingSnapshot: snapshots.get(key),
          skillFilter: ["scan-proof"],
        });
        snapshots.set(key, snapshot);
        return snapshot;
      };
      for (const params of affected) {
        expect((await prepare(params)).prompt).toContain("Original verified preparation");
      }
      const healthy = { workspaceDir: healthyWorkspace, config: {} };
      const healthySnapshot = await prepare(healthy);
      if (scope === "execution" || scope === "shared") {
        await prepare({ workspaceDir, config });
        await prepare({ workspaceDir, config, executionWorkspaceDir: otherExecution });
      }
      let active = watchForSkillRoot(root).watcher;
      for (const watcher of createdWatchers) {
        if (watcher !== active) {
          watcher.emit("ready");
        }
      }
      active.emit("ready");
      let pending = watchForSkillRoot(root).watcher;
      vi.useFakeTimers();
      if (phase === "replacement") {
        pending.emit("ready");
        active = pending;
        const expanded = await fixture.createFixtureDirectory(
          scope === "shared"
            ? "shared/skills/expanded"
            : `${scope === "execution" ? "execution" : "workspace"}/skills/expanded`,
        );
        active.emit("all", "addDir", expanded);
        pending = watchForSkillRoot(root).watcher;
        expect(pending).not.toBe(active);
      }
      const unaffected = [
        getSkillsSourceVersion(healthyWorkspace),
        getSkillsSourceVersion(workspaceDir),
        getSkillsSourceVersion(workspaceDir, { executionWorkspaceDir: otherExecution }),
      ];
      pending.emit("error", Object.assign(new Error("verifier read failed"), { code: "EIO" }));
      expect(active.closed).toBe(false);
      expect(pending.closed).toBe(true);
      // Drain the one structural/error refresh before unobserved edits. Only
      // preparation's persistent availability fact can refresh the later reads.
      await vi.advanceTimersByTimeAsync(500);
      for (const params of affected) {
        await prepare(params);
      }
      const watcherCount = createdWatchers.length;
      for (const description of ["Second preparation", "Third preparation"]) {
        await write(description);
        for (const params of affected) {
          expect((await prepare(params)).prompt).toContain(description);
        }
        expect(await prepare(healthy)).toBe(healthySnapshot);
      }
      expect(getSkillsSourceVersion(healthyWorkspace)).toBe(unaffected[0]);
      if (scope === "execution") {
        expect(getSkillsSourceVersion(workspaceDir)).toBe(unaffected[1]);
        expect(
          getSkillsSourceVersion(workspaceDir, { executionWorkspaceDir: otherExecution }),
        ).toBe(unaffected[2]);
      }
      const seen = vi.fn();
      refresh.registerSkillsChangeListener(seen);
      const version = getSkillsSnapshotVersion(workspaceDir);
      await prepare(request);
      await prepare(request);
      expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
      expect(seen).not.toHaveBeenCalled();
      expect(createdWatchers).toHaveLength(watcherCount);

      const lateExecution =
        scope === "shared"
          ? {
              workspaceDir,
              config,
              executionWorkspaceDir: await fixture.createFixtureDirectory("late-execution"),
            }
          : undefined;
      if (lateExecution) {
        const late = {
          workspaceDir: await fixture.createFixtureDirectory("late-subscriber"),
          config,
        };
        await prepare(late);
        expect(seen).toHaveBeenCalledExactlyOnceWith({
          workspaceDir: late.workspaceDir,
          reason: "watch-unavailable",
          changedPath: expect.any(String),
        });
        seen.mockClear();
        await prepare(late);
        expect(seen).not.toHaveBeenCalled();
        // Acquire while shared coverage is failed, but leave this execution
        // root missing so its later readiness can expose a stale shared latch.
        await prepare(lateExecution);
        for (const watcher of createdWatchers) {
          if (watcher !== active) {
            watcher.emit("ready");
          }
        }
      }

      const added = await fixture.createFixtureDirectory(
        scope === "shared"
          ? "shared/skills/recovered"
          : `${scope === "execution" ? "execution" : "workspace"}/skills/recovered`,
      );
      active.emit("all", "addDir", added);
      const recovery = watchForSkillRoot(root).watcher;
      recovery.emit("ready");
      expect(active.closed).toBe(true);
      expect(recovery.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      const readyVersion = getSkillsSourceVersion(workspaceDir, request);
      await prepare(request);
      await prepare(request);
      expect(getSkillsSourceVersion(workspaceDir, request)).toBe(readyVersion);
      expect(await prepare(healthy)).toBe(healthySnapshot);
      expect(getSkillsSourceVersion(healthyWorkspace)).toBe(unaffected[0]);
      if (scope === "execution") {
        expect(getSkillsSourceVersion(workspaceDir)).toBe(unaffected[1]);
        expect(
          getSkillsSourceVersion(workspaceDir, { executionWorkspaceDir: otherExecution }),
        ).toBe(unaffected[2]);
      }
      if (lateExecution) {
        const otherRequest = { workspaceDir, config, executionWorkspaceDir: otherExecution };
        const baseSnapshot = await prepare(request);
        const otherSnapshot = await prepare(otherRequest);
        const baseVersion = getSkillsSourceVersion(workspaceDir);
        const otherVersion = getSkillsSourceVersion(workspaceDir, otherRequest);
        const executionRoot = path.join(lateExecution.executionWorkspaceDir, "skills");
        const ancestor = watchForSkillRoot(executionRoot).watcher;
        const existingWatchers = new Set(createdWatchers);
        await fixture.createFixtureDirectory("late-execution/skills");
        ancestor.emit("all", "addDir", executionRoot);
        for (const watcher of createdWatchers) {
          if (!existingWatchers.has(watcher)) {
            watcher.emit("ready");
          }
        }
        await Promise.resolve();
        expect(getSkillsSourceVersion(workspaceDir)).toBe(baseVersion);
        expect(getSkillsSourceVersion(workspaceDir, otherRequest)).toBe(otherVersion);
        expect(await prepare(request)).toBe(baseSnapshot);
        expect(await prepare(otherRequest)).toBe(otherSnapshot);
      }
    },
  );

  it("keeps delayed execution readiness scoped after shared startup was published", async () => {
    const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
    const workspaceDir = fixture.workspaceDir;
    const executionWorkspaceDir = await fixture.createFixtureDirectory("delayed-execution");
    const otherExecution = await fixture.createFixtureDirectory("other-execution");
    const root = path.join(executionWorkspaceDir, "skills");
    await writeSkill({
      dir: path.join(root, "delayed-proof"),
      name: "delayed-proof",
      description: "Before verification",
    });
    const execution = { workspaceDir, executionWorkspaceDir };
    const other = { workspaceDir, executionWorkspaceDir: otherExecution };
    const prepare = async (
      request: { workspaceDir: string; executionWorkspaceDir?: string },
      existingSnapshot?: SkillSnapshot,
    ) =>
      (
        await resolveReusableWorkspaceSkillSnapshot({
          ...request,
          config: {},
          existingSnapshot,
          skillFilter: ["delayed-proof"],
        })
      ).snapshot;
    const executionSnapshot = await prepare(execution);
    await prepare({ workspaceDir });
    await prepare(other);
    const beforeSharedReady = getSkillsSourceVersion(workspaceDir);
    const active = watchForSkillRoot(root).watcher;
    for (const watcher of createdWatchers) {
      if (watcher !== active) {
        watcher.emit("ready");
      }
    }
    await Promise.resolve();
    expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(beforeSharedReady);
    const baseSnapshot = await prepare({ workspaceDir });
    const otherSnapshot = await prepare(other);
    const baseVersion = getSkillsSourceVersion(workspaceDir);
    const otherVersion = getSkillsSourceVersion(workspaceDir, other);
    const executionVersion = getSkillsSourceVersion(workspaceDir, execution);
    active.emit("ready");
    const verification = watchForSkillRoot(root).watcher;
    expect(verification).not.toBe(active);
    expect(getSkillsSourceVersion(workspaceDir)).toBe(baseVersion);
    verification.emit("ready");
    expect(active.closed).toBe(true);
    expect(getSkillsSourceVersion(workspaceDir, execution)).toBeGreaterThan(executionVersion);
    expect(getSkillsSourceVersion(workspaceDir)).toBe(baseVersion);
    expect(getSkillsSourceVersion(workspaceDir, other)).toBe(otherVersion);
    expect(await prepare({ workspaceDir }, baseSnapshot)).toBe(baseSnapshot);
    expect(await prepare(other, otherSnapshot)).toBe(otherSnapshot);
    expect((await prepare(execution, executionSnapshot)).prompt).toContain("Before verification");
  });

  it("retains scoped ancestor outage across replacement, release and overlapping reacquisition", async () => {
    const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
    const {
      root,
      intermediate,
      params,
      write,
      content,
      ancestorWatcher: failedAncestor,
    } = await acquirePromotedRoot("ancestor-gap");
    const containedRoot = path.join(intermediate, "contained-skills");
    const writeContained = (description: string) =>
      writeSkill({
        dir: path.join(containedRoot, "ancestor-proof"),
        name: "ancestor-proof",
        description,
      });
    await writeContained("First contained preparation");
    const contained = {
      ...params,
      workspaceDir: await fixture.createFixtureDirectory("contained-subscriber"),
      config: { skills: { load: { extraDirs: [containedRoot] } } },
    };
    const overlap = {
      ...params,
      workspaceDir: await fixture.createFixtureDirectory("overlap-subscriber"),
    };
    const healthy = {
      ...params,
      workspaceDir: await fixture.createFixtureDirectory("healthy-sibling"),
      config: { skills: { load: { extraDirs: [] } } },
    };
    const snapshots = new Map<string, SkillSnapshot>();
    const prepare = async (request: typeof params) => {
      const { snapshot } = await resolveReusableWorkspaceSkillSnapshot({
        ...request,
        existingSnapshot: snapshots.get(request.workspaceDir),
      });
      snapshots.set(request.workspaceDir, snapshot);
      return snapshot;
    };
    for (const request of [params, contained, overlap, healthy]) {
      await prepare(request);
    }
    for (const watcher of createdWatchers) {
      watcher.emit("ready");
    }
    await Promise.resolve();
    const active = watchForSkillRoot(root).watcher;
    expect(active).not.toBe(content);
    const healthySnapshot = await prepare(healthy);
    const healthyVersion = getSkillsSourceVersion(healthy.workspaceDir);
    expect((await prepare(params)).prompt).toContain("First preparation");
    expect((await prepare(contained)).prompt).toContain("First contained preparation");
    const changes = vi.fn();
    refresh.registerSkillsChangeListener(changes);
    failedAncestor.emit("error", Object.assign(new Error("ancestor read failed"), { code: "EIO" }));
    expect(
      changes.mock.calls.some(
        ([event]) =>
          event.workspaceDir === contained.workspaceDir && event.reason === "watch-unavailable",
      ),
    ).toBe(true);
    // Replace real paths while ancestor delivery is unavailable. Existing
    // logical content watchers still represent the old directory inodes.
    await fs.rename(intermediate, `${intermediate}-retired`);
    await write("After ancestor replacement");
    await writeContained("After contained replacement");
    expect((await prepare(params)).prompt).toContain("After ancestor replacement");
    expect((await prepare(contained)).prompt).toContain("After contained replacement");
    failedAncestor.emit("ready");
    const lateRoot = path.join(intermediate, "late-skills");
    const late = {
      ...params,
      workspaceDir: await fixture.createFixtureDirectory("late-ancestor-subscriber"),
      config: { skills: { load: { extraDirs: [lateRoot] } } },
    };
    await prepare(late);
    const replacement = watchForSkillRoot(lateRoot).watcher;
    expect(replacement).not.toBe(failedAncestor);
    expect(failedAncestor.closed).toBe(true);
    replacement.emit("ready");
    for (const description of ["Second silent preparation", "Third silent preparation"]) {
      await write(description);
      await writeContained(description);
      expect((await prepare(params)).prompt).toContain(description);
      expect((await prepare(overlap)).prompt).toContain(description);
      expect((await prepare(contained)).prompt).toContain(description);
      expect(await prepare(healthy)).toBe(healthySnapshot);
      expect(getSkillsSourceVersion(healthy.workspaceDir)).toBe(healthyVersion);
    }
    await writeSkill({
      dir: path.join(lateRoot, "ancestor-proof"),
      name: "ancestor-proof",
      description: "Late source",
    });
    replacement.emit("all", "addDir", lateRoot);
    for (const watcher of createdWatchers) {
      watcher.emit("ready");
    }
    expect((await prepare(late)).prompt).toContain("Late source");
    await writeSkill({
      dir: path.join(lateRoot, "ancestor-proof"),
      name: "ancestor-proof",
      description: "Late silent edit",
    });
    expect((await prepare(late)).prompt).toContain("Late silent edit");
    refresh.ensureSkillsWatcher({ ...params, config: { skills: { load: { watch: false } } } });
    expect(active.closed).toBe(false); // The overlapping workspace retains this handle.
    await write("After overlapping reacquisition");
    expect((await prepare(params)).prompt).toContain("After overlapping reacquisition");
    for (const request of [params, overlap]) {
      refresh.ensureSkillsWatcher({ ...request, config: { skills: { load: { watch: false } } } });
    }
    expect(active.closed).toBe(true);
    await prepare(params);
    for (const watcher of createdWatchers) {
      watcher.emit("ready");
    }
    await prepare(params);
    await write("After logical replacement readiness");
    expect((await prepare(params)).prompt).toContain("After logical replacement readiness");
    expect(await prepare(healthy)).toBe(healthySnapshot);
    expect(getSkillsSourceVersion(healthy.workspaceDir)).toBe(healthyVersion);
  });

  it("publishes verified rescan content while an initial ancestor is still pending", async () => {
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const { root, params, write, content, ancestorWatcher } =
      await acquirePromotedRoot("pending-ancestor");
    content.emit("ready");
    const active = watchForSkillRoot(root).watcher;
    active.emit("ready");
    const read = () =>
      loadWorkspaceSkills(params.workspaceDir, params)
        .filter((entry) => entry.skill.name === "ancestor-proof")
        .map((entry) => entry.skill.description);
    expect(read()).toEqual(["First preparation"]);
    vi.useFakeTimers();
    const expanded = await fixture.createFixtureDirectory(
      "pending-ancestor/nested/skills/expanded",
    );
    active.emit("all", "addDir", expanded);
    const verifier = watchForSkillRoot(root).watcher;
    await vi.advanceTimersByTimeAsync(500);
    expect(read()).toEqual(["First preparation"]);
    await write("Discovered by verified rescan");
    expect(read()).toEqual(["First preparation"]);
    verifier.emit("ready");
    expect(read()).toEqual(["Discovered by verified rescan"]);
    expect(ancestorWatcher.closed).toBe(false);
    expect(active.closed).toBe(true);
  });

  it("keeps a content error unavailable when a replacement ancestor becomes ready first", async () => {
    const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
    const { root, intermediate, params, write, content, ancestorWatcher } =
      await acquirePromotedRoot("crossed-errors");
    ancestorWatcher.emit("ready");
    content.emit("ready");
    const active = watchForSkillRoot(root).watcher;
    active.emit("ready");
    let snapshot = (await resolveReusableWorkspaceSkillSnapshot(params)).snapshot;
    vi.useFakeTimers();
    const expanded = await fixture.createFixtureDirectory("crossed-errors/nested/skills/expanded");
    active.emit("all", "addDir", expanded);
    const verifier = watchForSkillRoot(root).watcher;
    verifier.emit("error", Object.assign(new Error("content read failed"), { code: "EIO" }));
    ancestorWatcher.emit(
      "error",
      Object.assign(new Error("ancestor read failed"), { code: "EIO" }),
    );
    await vi.advanceTimersByTimeAsync(500);
    snapshot = (
      await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: snapshot })
    ).snapshot;
    const otherRoot = path.join(intermediate, "other-skills");
    refresh.ensureSkillsWatcher({
      workspaceDir: await fixture.createFixtureDirectory("crossed-error-subscriber"),
      config: { skills: { load: { extraDirs: [otherRoot] } } },
    });
    const replacement = watchForSkillRoot(otherRoot).watcher;
    expect(replacement).not.toBe(ancestorWatcher);
    replacement.emit("ready");
    expect(active.closed).toBe(false);
    expect(verifier.closed).toBe(true);
    for (const description of ["Second preparation", "Third preparation"]) {
      await write(description);
      snapshot = (
        await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: snapshot })
      ).snapshot;
      expect(snapshot.prompt).toContain(description);
    }
    const recovered = await fixture.createFixtureDirectory(
      "crossed-errors/nested/skills/recovered",
    );
    active.emit("all", "addDir", recovered);
    const recovery = watchForSkillRoot(root).watcher;
    recovery.emit("ready");
    expect(active.closed).toBe(true);
    expect(recovery.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: snapshot });
    await write("Content verification cannot restore lost ancestor coverage");
    snapshot = (
      await resolveReusableWorkspaceSkillSnapshot({ ...params, existingSnapshot: snapshot })
    ).snapshot;
    expect(snapshot.prompt).toContain("Content verification cannot restore lost ancestor coverage");
  });

  it.each([false, true])(
    "verifies recovery after an initial read error (late ready=%s)",
    async (lateReady) => {
      vi.useFakeTimers();
      const { root, active } = acquire();
      active.emit("error", Object.assign(new Error("initial read failed"), { code: "EIO" }));
      const failed = getSkillsSourceVersion(fixture.workspaceDir);
      const changed = vi.fn();
      refresh.registerSkillsChangeListener(changed);
      if (lateReady) {
        active.emit("ready");
      } else {
        const second = await fixture.createFixtureDirectory("workspace/skills/second");
        active.emit("all", "addDir", second);
      }
      const healthy = watchForSkillRoot(root).watcher;
      healthy.emit("ready");
      const verification = watchForSkillRoot(root).watcher;
      expect(verification).not.toBe(healthy);
      expect(active.closed).toBe(true);
      expect(healthy.closed).toBe(false);
      expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(failed);
      expect(changed).not.toHaveBeenCalled();
      verification.emit("ready");
      expect(healthy.closed).toBe(true);
      expect(verification.closed).toBe(false);
      expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(failed);
      expect(changed).toHaveBeenCalledOnce();
    },
  );

  it.each(["native", "unknown-name", "polling"] as const)(
    "keeps coverage until a stable scan follows %s structural overlap",
    async (kind) => {
      vi.useFakeTimers();
      vi.stubEnv("CHOKIDAR_USEPOLLING", kind === "polling" ? "true" : "false");
      const { root, active, pending } = start();
      for (const watcher of [active, pending]) {
        if (kind === "polling") {
          watcher.emit("raw", "change", root, {
            curr: { isDirectory: () => true },
            prev: { isDirectory: () => true },
          });
        } else {
          watcher.emit("raw", "rename", kind === "native" ? "second" : undefined, {
            watchedPath: root,
          });
        }
      }
      // Do not deliver normalized addDir: the native observation precedes its scan.
      pending.emit("ready");
      const replacement = watchForSkillRoot(root).watcher;
      expect(replacement).not.toBe(pending);
      expect(pending.closed).toBe(true);
      expect(active.closed).toBe(false);
      const version = getSkillsSourceVersion(fixture.workspaceDir);
      replacement.emit("ready");
      expect(active.closed).toBe(true);
      expect(replacement.closed).toBe(false);
      expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(version);
      expect(
        watchMock.mock.calls.filter(
          ([watched, options]) => watched === root.replaceAll("\\", "/") && options.depth > 0,
        ),
      ).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(500);
    },
  );

  it.each([false, true])(
    "does not restart scans for supporting-file writes (polling=%s)",
    (polling) => {
      vi.useFakeTimers();
      vi.stubEnv("CHOKIDAR_USEPOLLING", String(polling));
      const { root, active, pending } = start();
      const file = path.join(root, "first", "README.md");
      for (const watcher of [active, pending]) {
        watcher.emit(
          "raw",
          "change",
          polling ? file : "README.md",
          polling
            ? {
                curr: { isDirectory: () => false },
                prev: { isDirectory: () => false },
              }
            : { watchedPath: path.dirname(file) },
        );
      }
      pending.emit("ready");
      expect(active.closed).toBe(true);
      expect(watchForSkillRoot(root).watcher).toBe(pending);
      expect(
        watchMock.mock.calls.filter(
          ([watched, options]) => watched === root.replaceAll("\\", "/") && options.depth > 0,
        ),
      ).toHaveLength(3);
    },
  );

  it("retains the active watcher after a failed rescan and permits a later directory wave", async () => {
    vi.useFakeTimers();
    const { root, active, pending } = start();
    pending.emit("error", Object.assign(new Error("scan failed"), { code: "EIO" }));
    expect(pending.closed).toBe(true);
    expect(active.closed).toBe(false);
    pending.emit("ready");
    expect(watchForSkillRoot(root).watcher).toBe(active);
    const before = getSkillsSourceVersion(fixture.workspaceDir);
    active.emit("all", "change", path.join(root, "first", "SKILL.md"));
    await vi.advanceTimersByTimeAsync(250);
    expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(before);
    active.emit("all", "addDir", path.join(root, "second"));
    const replacement = watchForSkillRoot(root).watcher;
    expect(replacement).not.toBe(active);
    replacement.emit("ready");
    expect(active.closed).toBe(true);
  });

  it.each(
    (["initial", "replacement"] as const).flatMap((phase) =>
      (["active", "pending"] as const).map((source) => ({ phase, source })),
    ),
  )(
    "falls back after native capacity failure from $source during $phase coverage",
    ({ phase, source }) => {
      vi.useFakeTimers();
      const watches = start(phase);
      watches[source].emit(
        "error",
        Object.assign(new Error("native capacity"), { code: "ENOSPC", syscall: "watch" }),
      );
      expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
      const count = createdWatchers.length;
      const version = getSkillsSourceVersion(fixture.workspaceDir);
      refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
      expect(createdWatchers).toHaveLength(count);
      expect(getSkillsSourceVersion(fixture.workspaceDir)).toBeGreaterThan(version);
    },
  );

  it("keeps shared subscriptions when another workspace joins during a rescan", async () => {
    vi.useFakeTimers();
    const { root, active, pending } = start();
    const secondWorkspace = await fixture.createFixtureDirectory("second-workspace");
    const config = { skills: { load: { extraDirs: [root] } } };
    refresh.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
    const versions = [fixture.workspaceDir, secondWorkspace].map((workspaceDir) =>
      getSkillsSourceVersion(workspaceDir),
    );
    pending.emit("ready");
    expect(active.closed).toBe(true);
    for (const [index, workspaceDir] of [fixture.workspaceDir, secondWorkspace].entries()) {
      expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(versions[index]!);
    }
    refresh.ensureSkillsWatcher({
      workspaceDir: fixture.workspaceDir,
      config: { skills: { load: { watch: false } } },
    });
    expect(pending.closed).toBe(false);
    refresh.ensureSkillsWatcher({
      workspaceDir: secondWorkspace,
      config: { skills: { load: { watch: false } } },
    });
    expect(pending.closed).toBe(true);
  });

  it.each(["initial", "replacement"] as const)(
    "joins the retired generation when %s publication closes all subscriptions",
    async (phase) => {
      vi.useFakeTimers();
      const { active, pending } = start(phase);
      const release = createDeferredCore();
      const close = active.close.getMockImplementation()!;
      active.close.mockImplementation(async () => {
        await close();
        await release.promise;
      });
      let closing: Promise<void> | undefined;
      let settled = false;
      refresh.registerSkillsChangeListener((event) => {
        if (event.workspaceDir === fixture.workspaceDir && event.reason === "watch") {
          closing = refresh.closeSkillsWatchers().then(() => {
            settled = true;
          });
        }
      });
      try {
        pending.emit("ready");
        await vi.advanceTimersByTimeAsync(0);
        expect(closing).toBeDefined();
        expect(settled).toBe(false);
        expect(active.closed).toBe(true);
        expect(pending.closed).toBe(true);
        expect(active.close).toHaveBeenCalledOnce();
        expect(pending.close).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await closing;
      }
      expect(settled).toBe(true);
    },
  );

  it.each(["initial", "replacement"] as const)(
    "joins both native closes and ignores late events during %s shutdown",
    async (phase) => {
      vi.useFakeTimers();
      const { active, pending } = start(phase);
      const release = createDeferredCore();
      for (const watcher of [active, pending]) {
        const close = watcher.close.getMockImplementation()!;
        watcher.close.mockImplementation(async () => {
          await close();
          await release.promise;
        });
      }
      let settled = false;
      const closing = refresh.closeSkillsWatchers().then(() => {
        settled = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        expect(active.closed).toBe(true);
        expect(pending.closed).toBe(true);
        const version = getSkillsSourceVersion(fixture.workspaceDir);
        pending.emit("ready");
        active.emit("all", "addDir", "late");
        expect(() => pending.emit("error", new Error("late scan"))).not.toThrow();
        expect(getSkillsSourceVersion(fixture.workspaceDir)).toBe(version);
      } finally {
        release.resolve();
        await closing;
      }
      expect(settled).toBe(true);
    },
  );
});
