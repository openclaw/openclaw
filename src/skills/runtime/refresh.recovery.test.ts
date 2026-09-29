import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { err } from "@openclaw/normalization-core/result";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { getSkillsSourceVersion } from "./refresh-state.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
  waitForSkillsWatcherTurn,
} from "./refresh.watcher.test-support.js";

const {
  createdWatchers,
  watchMock,
  nativeWatchMock,
  nativeContentWatchMock,
  watchForSkillRoot,
  readyAll,
  watcherAdmissions,
} = createSkillsWatcherMock();
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

const { shouldUseNativeSkillsWatcher } = await import("./refresh-watch-transport.js");

let refresh: typeof import("./refresh.js");
describe("skills ancestor recovery ownership", () => {
  const fixture = useSkillsWatcherFixture();
  beforeAll(async () => {
    refresh = await import("./refresh.js");
  });
  beforeEach(() => {
    // Certified recovery needs either owned native handles or pathname polling.
    vi.stubEnv("CHOKIDAR_USEPOLLING", String(!shouldUseNativeSkillsWatcher(false)));
    watchMock.mockClear();
    createdWatchers.length = 0;
  });
  const family = async (existing: boolean) => {
    // Keep workspaces outside the parent entry also observed on Darwin.
    const ancestor = await fixture.createFixtureDirectory("family/observed");
    const left = path.join(ancestor, "left", "skills");
    const right = path.join(ancestor, "right", "skills");
    const createRequest = async (root: string, index: number) => ({
      workspaceDir: await fixture.createFixtureDirectory(`subscriber-${index}`),
      config: { skills: { load: { extraDirs: [root] } } },
    });
    const requests = await Promise.all([createRequest(left, 0), createRequest(right, 1)]);
    for (const request of requests) {
      refresh.ensureSkillsWatcher(request);
    }
    let parent = watchForSkillRoot(left).watcher;
    expect(watchForSkillRoot(right).watcher).toBe(parent);
    const write = (root: string, description: string) =>
      writeSkill({ dir: path.join(root, "proof"), name: "proof", description });
    if (existing) {
      await write(left, "Left original");
      await write(right, "Right original");
    }
    await readyAll();
    await Promise.resolve();
    await readyAll();
    const parentIndex = watchMock.mock.calls.findLastIndex(
      ([watched, options], index) =>
        watched === ancestor.replaceAll("\\", "/") &&
        options.depth === 0 &&
        !expectDefined(createdWatchers[index], "created watcher").closed,
    );
    expect(parentIndex).toBeGreaterThanOrEqual(0);
    parent = expectDefined(createdWatchers[parentIndex], "shared parent watcher");
    return { ancestor, left, right, requests, parent, write };
  };

  it.each([false, true])(
    "keeps the healthy shared parent and sibling when one missing child appears (pooled=%s)",
    async (pooled) => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        if (pooled) {
          Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
          vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
        }
        const { left, right, requests, parent, write } = await family(false);
        const siblingVersion = getSkillsSourceVersion(requests[1].workspaceDir);
        const changed = vi.fn();
        refresh.registerSkillsChangeListener(changed);
        await write(left, "New left");
        parent.emit("all", pooled ? "addDir" : "ancestor", path.dirname(left));
        expect(parent.closed).toBe(false);
        expect(watchForSkillRoot(right).watcher).toBe(parent);
        await vi.waitFor(() =>
          expect(watchForSkillRoot(left).watchRoot).toBe(left.replaceAll("\\", "/")),
        );
        await readyAll();
        await Promise.resolve();
        await readyAll();
        expect(refresh.reconcileSkillsWatcherCoverage(requests[0])).toBe(true);
        expect(getSkillsSourceVersion(requests[1].workspaceDir)).toBe(siblingVersion);
        expect(
          changed.mock.calls.every(([event]) => event.workspaceDir !== requests[1].workspaceDir),
        ).toBe(true);
      } finally {
        try {
          await refresh.closeSkillsWatchers();
        } finally {
          Object.defineProperty(process, "platform", platform);
        }
      }
    },
  );

  it("admits a second structural epoch from the same parent during verification", async () => {
    const { left, right, requests, parent, write } = await family(true);
    const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
    const read = () =>
      loadWorkspaceSkills(requests[0].workspaceDir, requests[0]).find(
        (entry) => entry.skill.name === "proof",
      )?.skill.description;
    expect(read()).toBe("Left original");
    const sibling = watchForSkillRoot(right).watcher;
    const first = watchForSkillRoot(left).watcher;
    await fs.rename(path.dirname(left), `${path.dirname(left)}-first`);
    await write(left, "First replacement");
    parent.emit("all", "ancestor", path.dirname(left));
    await vi.waitFor(() => expect(watchForSkillRoot(left).watcher).not.toBe(first));
    const second = watchForSkillRoot(left).watcher;
    second.emit("ready");
    const heldVerifier = watchForSkillRoot(left).watcher;
    expect(heldVerifier).not.toBe(second);
    await fs.rename(path.dirname(left), `${path.dirname(left)}-second`);
    await write(left, "Second replacement");
    parent.emit("all", "ancestor", path.dirname(left));
    expect(parent.closed).toBe(false);
    expect(sibling.closed).toBe(false);
    expect(second.closed).toBe(true);
    expect(heldVerifier.closed).toBe(true);
    await vi.waitFor(() => expect(watchForSkillRoot(left).watcher).not.toBe(heldVerifier));
    heldVerifier.emit("ready");
    await readyAll();
    await Promise.resolve();
    await readyAll();
    expect(read()).toBe("Second replacement");
    await write(left, "Later direct edit");
    vi.useFakeTimers();
    watchForSkillRoot(left).watcher.emit("all", "change", path.join(left, "proof", "SKILL.md"));
    await vi.advanceTimersByTimeAsync(250);
    expect(read()).toBe("Later direct edit");
  });

  it("reuses verified sibling coverage for existing and late owners while another target is unavailable", async () => {
    const { left, right, requests, parent } = await family(true);
    const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
    const prompt = await import("../loading/workspace-skill-prompt.js");
    const build = vi.spyOn(prompt, "buildSkillSnapshot");
    const first = watchForSkillRoot(left).watcher;
    parent.emit("error", Object.assign(new Error("ancestor unavailable"), { code: "EIO" }));
    await vi.waitFor(() => expect(watchForSkillRoot(left).watcher).not.toBe(first));
    const pendingRight = watchForSkillRoot(right).watcher;
    for (const watcher of createdWatchers) {
      if (watcher !== pendingRight) {
        watcher.emit("ready");
      }
    }
    await Promise.resolve();
    const leftSnapshot = (await resolveReusableWorkspaceSkillSnapshot(requests[0])).snapshot;
    const builds = build.mock.calls.length;
    const version = getSkillsSourceVersion(requests[0].workspaceDir);
    expect(
      (
        await resolveReusableWorkspaceSkillSnapshot({
          ...requests[0],
          existingSnapshot: leftSnapshot,
        })
      ).snapshot,
    ).toBe(leftSnapshot);
    expect(build).toHaveBeenCalledTimes(builds);
    expect(getSkillsSourceVersion(requests[0].workspaceDir)).toBe(version);
    const late = {
      ...requests[0],
      workspaceDir: await fixture.createFixtureDirectory("late-left"),
    };
    refresh.ensureSkillsWatcher(late);
    for (const watcher of createdWatchers) {
      if (watcher !== pendingRight) {
        watcher.emit("ready");
      }
    }
    await Promise.resolve();
    expect(refresh.reconcileSkillsWatcherCoverage(late)).toBe(true);
    expect(refresh.reconcileSkillsWatcherCoverage(requests[1])).toBe(false);
    const lateSnapshot = (await resolveReusableWorkspaceSkillSnapshot(late)).snapshot;
    const lateBuilds = build.mock.calls.length;
    expect(
      (
        await resolveReusableWorkspaceSkillSnapshot({
          ...late,
          existingSnapshot: lateSnapshot,
        })
      ).snapshot,
    ).toBe(lateSnapshot);
    expect(build).toHaveBeenCalledTimes(lateBuilds);
  });

  it.each(["outward retreat", "same-path replacement"] as const)(
    "joins shutdown without admitting a replacement after pooled %s publication",
    async (loss) => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const release = createDeferredCore();
      let closing: Promise<void> | undefined;
      let settled = false;
      try {
        Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
        vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
        const { ancestor, requests, parent } = await family(false);
        expect(refresh.reconcileSkillsWatcherCoverage(requests[0])).toBe(true);
        const owned = createdWatchers.filter((watcher) => !watcher.closed);
        const admissions = watchMock.mock.calls.length;
        const originalClose = parent.close.getMockImplementation()!;
        parent.close.mockImplementationOnce(async () => {
          await originalClose();
          await release.promise;
        });
        refresh.registerSkillsChangeListener((event) => {
          if (
            event.workspaceDir === requests[0].workspaceDir &&
            event.reason === "watch-unavailable"
          ) {
            closing = refresh.closeSkillsWatchers().then(() => {
              settled = true;
            });
          }
        });
        await fs.rename(ancestor, `${ancestor}-retired`);
        if (loss === "same-path replacement") {
          await fs.mkdir(ancestor);
          parent.emit("all", "unlinkDir", ancestor);
        } else {
          parent.emit("raw", "rename", undefined, { watchedPath: ancestor });
        }
        expect(closing).toBeDefined();
        await waitForSkillsWatcherTurn();
        expect(settled).toBe(false);
        expect(watchMock).toHaveBeenCalledTimes(admissions);
        for (const watcher of owned) {
          expect(watcher.closed).toBe(true);
          expect(watcher.close).toHaveBeenCalledOnce();
        }
        release.resolve();
        await closing;
        await waitForSkillsWatcherTurn();
        expect(settled).toBe(true);
        expect(watchMock).toHaveBeenCalledTimes(admissions);
        expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
      } finally {
        release.resolve();
        try {
          await closing;
          await refresh.closeSkillsWatchers();
        } finally {
          Object.defineProperty(process, "platform", platform);
        }
      }
    },
  );

  it("settles a failed ancestor retry without retiring already recovering content", async () => {
    const { ancestor, left, requests, parent, write } = await family(false);
    await write(left, "Existing content");
    parent.emit("all", "addDir", path.dirname(left));
    await readyAll();
    const admissions = watcherAdmissions;
    const beforeContent = admissions(left, false).length;
    const beforeAncestors = admissions(ancestor, true).length;
    const active = watchForSkillRoot(left).watcher;
    const releaseContent = createDeferredCore();
    const releaseAncestor = createDeferredCore();
    const originalClose = active.close.getMockImplementation()!;
    active.close.mockImplementationOnce(async () => {
      await originalClose();
      await releaseContent.promise;
    });
    const changes = vi.fn();
    refresh.registerSkillsChangeListener(changes);
    try {
      parent.emit("error", Object.assign(new Error("original ancestor lost"), { code: "EIO" }));
      await vi.waitFor(() => expect(admissions(ancestor, true)).toHaveLength(beforeAncestors + 1));
      const failedAncestor = admissions(ancestor, true).at(-1)!;
      const closeAncestor = failedAncestor.close.getMockImplementation()!;
      failedAncestor.close.mockImplementationOnce(async () => {
        const result = await closeAncestor();
        await releaseAncestor.promise;
        return result;
      });
      failedAncestor.emit(
        "error",
        Object.assign(new Error("fresh ancestor admission failed"), { code: "EACCES" }),
      );
      expect(failedAncestor.close).not.toHaveBeenCalled();
      releaseContent.resolve();
      await vi.waitFor(() => expect(failedAncestor.close).toHaveBeenCalledOnce());
      expect(admissions(left, false)).toHaveLength(beforeContent + 1);
      // Capture the exact admission even if a broken owner already closed it.
      // Holding the ancestor close prevents that failure from becoming a retry loop.
      const recovering = admissions(left, false).at(-1)!;
      expect(recovering).not.toBe(active);
      expect(recovering.closed).toBe(false);
      expect(recovering.close).not.toHaveBeenCalled();
      releaseAncestor.resolve();
      await vi.waitFor(() => expect(admissions(ancestor, true)).toHaveLength(beforeAncestors + 2));
      admissions(ancestor, true)
        .at(-1)!
        .emit(
          "error",
          Object.assign(new Error("ancestor remains unavailable"), { code: "EACCES" }),
        );
      await waitForSkillsWatcherTurn();
      expect(admissions(left, false)).toHaveLength(beforeContent + 1);
      expect(admissions(ancestor, true)).toHaveLength(beforeAncestors + 2);
      expect(recovering.closed).toBe(false);
      expect(recovering.close).not.toHaveBeenCalled();
      expect(changes.mock.calls.some(([event]) => event.reason === "watch-available")).toBe(false);

      // A later preparation may request a fresh attempt after the failed one settles.
      refresh.ensureSkillsWatcher(requests[0]);
      await readyAll();
      expect(admissions(left, false).length).toBeGreaterThan(beforeContent + 1);
      expect(refresh.reconcileSkillsWatcherCoverage(requests[0])).toBe(true);
    } finally {
      const closing = refresh.closeSkillsWatchers();
      releaseContent.resolve();
      releaseAncestor.resolve();
      await closing;
    }
    expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
  });

  it.each(["verified", "pending"] as const)(
    "reverifies %s content after ancestor observation returns",
    async (verification) => {
      const { ancestor, left, requests, parent, write } = await family(false);
      await write(left, "Original content");
      parent.emit("all", "addDir", path.dirname(left));
      await readyAll();
      const admissions = watcherAdmissions;
      const beforeAncestors = admissions(ancestor, true).length;
      const active = watchForSkillRoot(left).watcher;
      const releaseContent = createDeferredCore();
      const releaseAncestor = createDeferredCore();
      const closeContent = active.close.getMockImplementation()!;
      active.close.mockImplementationOnce(async () => {
        await closeContent();
        await releaseContent.promise;
      });
      const changes = vi.fn();
      refresh.registerSkillsChangeListener(changes);
      const available = () =>
        changes.mock.calls.filter(
          ([event]) =>
            event.workspaceDir === requests[0].workspaceDir && event.reason === "watch-available",
        );
      try {
        parent.emit("error", Object.assign(new Error("ancestor lost"), { code: "EIO" }));
        await vi.waitFor(() =>
          expect(admissions(ancestor, true)).toHaveLength(beforeAncestors + 1),
        );
        const failedAncestor = admissions(ancestor, true).at(-1)!;
        const closeAncestor = failedAncestor.close.getMockImplementation()!;
        failedAncestor.close.mockImplementationOnce(async () => {
          const result = await closeAncestor();
          await releaseAncestor.promise;
          return result;
        });
        failedAncestor.emit(
          "error",
          Object.assign(new Error("fresh ancestor admission failed"), { code: "EACCES" }),
        );
        releaseContent.resolve();
        await vi.waitFor(() => expect(failedAncestor.close).toHaveBeenCalledOnce());
        const recovering = admissions(left, false).at(-1)!;
        // Settle other observation roots, but drive these content generations
        // explicitly on both sides of the held shared-ancestor gap.
        const admittedWatchers = [...createdWatchers];
        for (const watcher of admittedWatchers) {
          if (!admissions(left, false).includes(watcher)) {
            watcher.emit("ready");
          }
        }
        const inventory = { [left]: ["proof"], [path.join(left, "proof")]: ["SKILL.md"] };
        recovering.getWatched.mockReturnValue(inventory);
        recovering.emit("ready");
        const gapVerifier = admissions(left, false).at(-1)!;
        expect(gapVerifier).not.toBe(recovering);
        gapVerifier.getWatched.mockReturnValue(inventory);
        if (verification === "verified") {
          gapVerifier.emit("ready");
        }
        expect(available()).toHaveLength(0);
        await fs.rename(ancestor, `${ancestor}-retired`);
        await write(left, "Same-shaped replacement");
        releaseAncestor.resolve();
        await vi.waitFor(() =>
          expect(admissions(ancestor, true)).toHaveLength(beforeAncestors + 2),
        );
        const restoredAncestor = admissions(ancestor, true).at(-1)!;
        restoredAncestor.emit("ready");
        expect(available()).toHaveLength(0);
        const afterBarrier = admissions(left, false).length;
        restoredAncestor.emit("ready");
        expect(admissions(left, false)).toHaveLength(afterBarrier);
        if (verification === "pending") {
          gapVerifier.emit("ready");
          expect(gapVerifier.closed).toBe(true);
        }
        expect(available()).toHaveLength(0);
        const freshVerifier = admissions(left, false).at(-1)!;
        expect(freshVerifier).not.toBe(gapVerifier);
        freshVerifier.getWatched.mockReturnValue(inventory);
        freshVerifier.emit("ready");
        expect(available()).toHaveLength(1);
        expect(refresh.reconcileSkillsWatcherCoverage(requests[0])).toBe(true);
        const settledAdmissions = admissions(left, false).length;
        restoredAncestor.emit("ready");
        expect(admissions(left, false)).toHaveLength(settledAdmissions);
        expect(available()).toHaveLength(1);
      } finally {
        const closing = refresh.closeSkillsWatchers();
        releaseContent.resolve();
        releaseAncestor.resolve();
        await closing;
      }
      expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
    },
  );

  it("joins a newly acquired shared ancestor when another listener shuts down", async () => {
    const { ancestor, requests, parent } = await family(false);
    const incoming = {
      workspaceDir: await fixture.createFixtureDirectory("incoming-subscriber"),
      config: { skills: { load: { extraDirs: [path.join(ancestor, "third", "skills")] } } },
    };
    const release = createDeferredCore();
    const originalClose = parent.close.getMockImplementation()!;
    parent.close.mockImplementationOnce(async () => {
      const result = await originalClose();
      await release.promise;
      return result;
    });
    let acquired = false;
    let closing: Promise<void> | undefined;
    let settled = false;
    let admissionsAtShutdown: number | undefined;
    refresh.registerSkillsChangeListener((event) => {
      if (event.reason !== "watch-unavailable") {
        return;
      }
      if (event.workspaceDir === requests[0].workspaceDir && !acquired) {
        acquired = true;
        refresh.ensureSkillsWatcher(incoming);
      } else if (event.workspaceDir === requests[1].workspaceDir && !closing) {
        closing = refresh.closeSkillsWatchers().then(() => {
          settled = true;
        });
        admissionsAtShutdown = watchMock.mock.calls.length;
      }
    });
    try {
      parent.emit("error", Object.assign(new Error("shared ancestor lost"), { code: "EIO" }));
      expect(acquired).toBe(true);
      expect(closing).toBeDefined();
      await waitForSkillsWatcherTurn();
      expect(settled).toBe(false);
      expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
      release.resolve();
      await closing;
      await waitForSkillsWatcherTurn();
      expect(settled).toBe(true);
      expect(watchMock.mock.calls.length).toBe(admissionsAtShutdown);
      expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
    } finally {
      release.resolve();
      await closing;
      await refresh.closeSkillsWatchers();
    }
  });

  it("cancels a queued failed-ancestor retry when its arriving subscriber releases", async () => {
    const { acquireSkillsAncestorWatcher } = await import("./refresh-ancestor-watch.js");
    const root = await fixture.createFixtureDirectory("released-retry");
    const subscription = () => ({
      path: path.join(root, "skills"),
      ignored: () => false,
      ready: vi.fn(),
      unavailable: vi.fn(),
      reconcile: vi.fn(),
      changed: vi.fn(),
      raw: vi.fn(),
      error: vi.fn(),
    });
    const retainedEvents = subscription();
    const usePolling = !shouldUseNativeSkillsWatcher(false);
    const retained = acquireSkillsAncestorWatcher(root, usePolling, retainedEvents);
    const watcher = createdWatchers.at(-1)!;
    let incoming: ReturnType<typeof acquireSkillsAncestorWatcher> | undefined;
    try {
      watcher.emit("ready");
      watcher.emit("error", Object.assign(new Error("retryable ancestor loss"), { code: "EIO" }));
      expect(retainedEvents.error).toHaveBeenCalledOnce();
      const admissions = watchMock.mock.calls.length;
      const incomingEvents = subscription();
      incoming = acquireSkillsAncestorWatcher(root, usePolling, incomingEvents);
      await incoming.release();
      await waitForSkillsWatcherTurn();
      expect(watchMock).toHaveBeenCalledTimes(admissions);
      expect(watcher.closed).toBe(false);
      expect(retainedEvents.unavailable).not.toHaveBeenCalled();
      expect(incomingEvents.unavailable).not.toHaveBeenCalled();
      expect(incomingEvents.error).not.toHaveBeenCalled();
    } finally {
      await incoming?.release();
      await retained.release();
    }
    expect(watcher.closed).toBe(true);
  });

  it.each(["shutdown", "unsubscribe", "re-ensure", "continue"] as const)(
    "preserves target-plan ownership during listener %s",
    async (action) => {
      const { pathWatchers } = await import("./refresh-watch-registry.js");
      const { ancestor, left, requests, parent, write } = await family(false);
      const request = {
        ...requests[0],
        workspaceDir:
          action === "continue"
            ? await fixture.createFixtureDirectory("joining-workspace")
            : requests[0].workspaceDir,
      };
      const shared = {
        ...request,
        workspaceDir: await fixture.createFixtureDirectory("shared-left"),
      };
      refresh.ensureSkillsWatcher(shared);
      await readyAll();
      expect(watchForSkillRoot(left).watchRoot).toBe(ancestor.replaceAll("\\", "/"));
      const prefix = path.join(ancestor, "aaa-prefix", "skills");
      const nested = path.join(ancestor, "yyy-nested", "skills");
      const tail = path.join(ancestor, "zzz-tail", "skills");
      for (const root of [prefix, nested, tail]) {
        await fs.mkdir(root, { recursive: true });
      }
      await write(left, "Promoted left");
      const outer = {
        ...request,
        config: { skills: { load: { extraDirs: [prefix, left, tail] } } },
      };
      const replacement = {
        ...request,
        config: { skills: { load: { extraDirs: [left, nested] } } },
      };
      const disabled = { ...request, config: { skills: { load: { watch: false } } } };
      const release = createDeferredCore();
      let closing: Promise<void> | undefined;
      let settled = false;
      const unavailableTargets = new Set(
        [...pathWatchers].filter(([, state]) => state.unavailable).map(([target]) => target),
      );
      const outages: string[][] = [];
      // Configured roots include both the root and its skills child; each
      // observation can retire independently when the missing root appears.
      const expectedOutages = [[left.replaceAll("\\", "/")]];
      if (action === "re-ensure" || action === "continue") {
        expectedOutages.push([path.join(left, "skills").replaceAll("\\", "/")]);
      }
      let prefixWatcher: ReturnType<typeof watchMock> | undefined;
      let admissionsAfterListener: number | undefined;
      if (action === "shutdown") {
        const originalClose = parent.close.getMockImplementation()!;
        parent.close.mockImplementationOnce(async () => {
          const result = await originalClose();
          await release.promise;
          return result;
        });
      }
      refresh.registerSkillsChangeListener((event) => {
        if (event.workspaceDir !== request.workspaceDir || event.reason !== "watch-unavailable") {
          return;
        }
        const newlyUnavailable = [...pathWatchers]
          .filter(([target, state]) => state.unavailable && !unavailableTargets.has(target))
          .map(([target]) => target);
        outages.push(newlyUnavailable);
        for (const target of newlyUnavailable) {
          unavailableTargets.add(target);
        }
        if (outages.length !== 1) {
          return;
        }
        prefixWatcher = watchForSkillRoot(prefix).watcher;
        if (action === "shutdown") {
          closing = refresh.closeSkillsWatchers().then(() => {
            settled = true;
          });
        } else if (action !== "continue") {
          refresh.ensureSkillsWatcher(action === "unsubscribe" ? disabled : replacement);
        }
        admissionsAfterListener = watchMock.mock.calls.length;
      });
      try {
        refresh.ensureSkillsWatcher(outer);
        expect(outages).toEqual(expectedOutages);
        expect(prefixWatcher).toBeDefined();
        if (action !== "continue") {
          expect(watchMock.mock.calls.length).toBe(admissionsAfterListener);
        }
        expect(watchMock.mock.calls.some(([root]) => root === tail.replaceAll("\\", "/"))).toBe(
          action === "continue",
        );
        await waitForSkillsWatcherTurn();
        expect(prefixWatcher?.closed).toBe(action !== "continue");
        if (action === "shutdown") {
          expect(closing).toBeDefined();
          expect(settled).toBe(false);
          expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
          release.resolve();
          await closing;
          expect(settled).toBe(true);
          expect(watchMock.mock.calls.length).toBe(admissionsAfterListener);
        } else {
          await readyAll();
          expect(refresh.reconcileSkillsWatcherCoverage(shared)).toBe(true);
          expect(watchForSkillRoot(left).watcher.closed).toBe(false);
          const admissions = watchMock.mock.calls.length;
          const current =
            action === "unsubscribe" ? disabled : action === "continue" ? outer : replacement;
          expect(refresh.reconcileSkillsWatcherCoverage(current)).toBe(action !== "unsubscribe");
          refresh.ensureSkillsWatcher(current);
          expect(watchMock).toHaveBeenCalledTimes(admissions);
          if (action === "re-ensure") {
            expect(watchForSkillRoot(nested).watcher.closed).toBe(false);
          }
        }
        expect(outages).toEqual(expectedOutages);
      } finally {
        release.resolve();
        await closing;
        await refresh.closeSkillsWatchers();
      }
    },
  );

  it.each(["error", "outward retreat"] as const)(
    "retains a missing target's lost pooled ancestor after %s",
    async (loss) => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      let peer: ReturnType<typeof watchMock> | undefined;
      try {
        Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
        vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
        const { ancestor, left, requests, parent } = await family(false);
        expect(refresh.reconcileSkillsWatcherCoverage(requests[0])).toBe(true);
        peer = watchMock(ancestor, watchForSkillRoot(left).options);
        peer.emit("ready");
        if (loss === "error") {
          parent.emit(
            "error",
            Object.assign(new Error("missing root observer lost"), { code: "EIO" }),
          );
        } else {
          await fs.rename(ancestor, `${ancestor}-retired`);
          parent.emit("all", "unlinkDir", ancestor);
        }
        await readyAll();
        expect(refresh.reconcileSkillsWatcherCoverage(requests[0])).toBe(false);
        expect(refresh.reconcileSkillsWatcherCoverage(requests[1])).toBe(false);
        await refresh.closeSkillsWatchers();
        expect(peer.closed).toBe(false);
        const later = {
          workspaceDir: await fixture.createFixtureDirectory("later-missing-subscriber"),
          config: { skills: { load: { extraDirs: [path.join(ancestor, "third", "skills")] } } },
        };
        refresh.ensureSkillsWatcher(later);
        await readyAll();
        expect(refresh.reconcileSkillsWatcherCoverage(later)).toBe(false);
        const admissions = watchMock.mock.calls.length;
        refresh.ensureSkillsWatcher(later);
        refresh.ensureSkillsWatcher(later);
        expect(watchMock).toHaveBeenCalledTimes(admissions);
        const healthy = { workspaceDir: fixture.workspaceDir };
        refresh.ensureSkillsWatcher(healthy);
        await readyAll();
        expect(refresh.reconcileSkillsWatcherCoverage(healthy)).toBe(true);
      } finally {
        try {
          await refresh.closeSkillsWatchers();
        } finally {
          try {
            await peer?.close();
          } finally {
            Object.defineProperty(process, "platform", platform);
          }
        }
      }
    },
  );

  it.each([
    { loss: "error", release: "unsubscribe" },
    { loss: "error", release: "shutdown" },
    { loss: "root loss", release: "unsubscribe" },
    { loss: "root loss", release: "shutdown" },
    { loss: "same-path replacement", release: "unsubscribe" },
    { loss: "same-path replacement", release: "shutdown" },
  ] as const)(
    "retains pooled observation uncertainty after $loss and $release",
    async ({ loss, release }) => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      let peer: ReturnType<typeof watchMock> | undefined;
      try {
        // Exercise the stock transport policy on every host; this is a state
        // regression, not evidence of native macOS filesystem delivery.
        Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
        vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
        const { left, right, requests, write } = await family(true);
        const enclosing = {
          ...requests[0],
          workspaceDir: await fixture.createFixtureDirectory("enclosing-pooled-owner"),
          config: { skills: { load: { extraDirs: [path.dirname(left)] } } },
        };
        refresh.ensureSkillsWatcher(enclosing);
        await readyAll();
        expect(refresh.reconcileSkillsWatcherCoverage(requests[0])).toBe(true);
        expect(refresh.reconcileSkillsWatcherCoverage(enclosing)).toBe(true);
        expect(refresh.reconcileSkillsWatcherCoverage(requests[1])).toBe(true);
        const active = watchForSkillRoot(left);
        peer = watchMock(left, active.options);
        peer.emit("ready");
        const changed = vi.fn();
        refresh.registerSkillsChangeListener(changed);
        if (loss === "error") {
          active.watcher.emit(
            "error",
            Object.assign(new Error("pooled content lost"), { code: "EIO" }),
          );
          await fs.rename(path.dirname(left), `${path.dirname(left)}-retired`);
          await write(left, "Replacement content");
          refresh.ensureSkillsWatcher(requests[0]);
        } else if (loss === "root loss") {
          await fs.rename(path.dirname(left), `${path.dirname(left)}-retired`);
          active.watcher.emit("all", "unlinkDir", left);
          await write(left, "Replacement content");
        } else {
          await fs.rename(path.dirname(left), `${path.dirname(left)}-retired`);
          await write(left, "Replacement content");
          active.watcher.emit("all", "unlinkDir", left);
          active.watcher.emit("all", "addDir", left);
        }
        await readyAll();
        expect(peer.closed).toBe(false);
        expect(refresh.reconcileSkillsWatcherCoverage(requests[0])).toBe(false);
        expect(refresh.reconcileSkillsWatcherCoverage(enclosing)).toBe(false);
        expect(refresh.reconcileSkillsWatcherCoverage(requests[1])).toBe(true);
        const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
        const read = () =>
          loadWorkspaceSkills(requests[0].workspaceDir, requests[0]).find(
            (entry) => entry.skill.name === "proof",
          )?.skill.description;
        expect(read()).toBe("Replacement content");
        await write(left, "Edit while pooled coverage is uncertain");
        expect(read()).toBe("Replacement content");
        const admissions = watchMock.mock.calls.length;
        refresh.ensureSkillsWatcher(requests[0]);
        expect(read()).toBe("Edit while pooled coverage is uncertain");
        refresh.ensureSkillsWatcher(requests[0]);
        expect(watchMock).toHaveBeenCalledTimes(admissions);
        expect(
          changed.mock.calls.some(
            ([event]) =>
              event.workspaceDir !== requests[1].workspaceDir && event.reason === "watch-available",
          ),
        ).toBe(false);

        if (release === "shutdown") {
          await refresh.closeSkillsWatchers();
        } else {
          for (const request of [requests[0], enclosing]) {
            refresh.ensureSkillsWatcher({
              ...request,
              config: { skills: { load: { watch: false } } },
            });
          }
          await waitForSkillsWatcherTurn();
        }
        expect(peer.closed).toBe(false);
        for (const [index, root] of [
          left,
          path.dirname(left),
          path.join(left, "proof"),
        ].entries()) {
          const reacquired = {
            workspaceDir: await fixture.createFixtureDirectory(`pooled-reacquired-${index}`),
            config: { skills: { load: { extraDirs: [root] } } },
          };
          refresh.ensureSkillsWatcher(reacquired);
          await readyAll();
          expect(refresh.reconcileSkillsWatcherCoverage(reacquired)).toBe(false);
          const count = watchMock.mock.calls.length;
          const version = getSkillsSourceVersion(reacquired.workspaceDir);
          refresh.ensureSkillsWatcher(reacquired);
          expect(getSkillsSourceVersion(reacquired.workspaceDir)).toBeGreaterThan(version);
          refresh.ensureSkillsWatcher(reacquired);
          expect(watchMock).toHaveBeenCalledTimes(count);
        }
        refresh.ensureSkillsWatcher(requests[1]);
        await readyAll();
        expect(watchForSkillRoot(right).watcher.closed).toBe(false);
        expect(refresh.reconcileSkillsWatcherCoverage(requests[1])).toBe(true);
        expect(
          changed.mock.calls.some(
            ([event]) =>
              event.workspaceDir !== requests[1].workspaceDir && event.reason === "watch-available",
          ),
        ).toBe(false);
      } finally {
        try {
          await refresh.closeSkillsWatchers();
        } finally {
          try {
            await peer?.close();
          } finally {
            Object.defineProperty(process, "platform", platform);
          }
        }
      }
    },
  );

  it.each([false, true])(
    "preserves failed retirement quarantine across shutdown (failure=%s)",
    async (failure) => {
      const { left, requests } = await family(true);
      const active = watchForSkillRoot(left).watcher;
      const originalClose = active.close.getMockImplementation()!;
      if (failure) {
        active.close.mockImplementationOnce(async () => {
          await originalClose();
          throw new Error("native retirement failed");
        });
      }
      await refresh.closeSkillsWatchers();
      const before = watchMock.mock.calls.filter(
        ([root, options]) => root === left.replaceAll("\\", "/") && options.depth > 0,
      ).length;
      expect(before).toBeGreaterThan(0);
      refresh.ensureSkillsWatcher(requests[0]);
      const after = watchMock.mock.calls.filter(
        ([root, options]) => root === left.replaceAll("\\", "/") && options.depth > 0,
      ).length;
      if (failure) {
        expect(after).toBe(before);
        expect(refresh.reconcileSkillsWatcherCoverage(requests[0])).toBe(false);
      } else {
        expect(after).toBeGreaterThan(before);
        await readyAll();
        await Promise.resolve();
        await readyAll();
        expect(refresh.reconcileSkillsWatcherCoverage(requests[0])).toBe(true);
      }
    },
  );

  it.runIf(shouldUseNativeSkillsWatcher(false))(
    "quarantines a failed final ancestor release for a different descendant after shutdown",
    async () => {
      const { ancestor, parent, requests } = await family(true);
      const failure = new Error("native ancestor close failed");
      const originalClose = parent.close.bind(parent);
      const close = vi.fn(async () => {
        await originalClose();
        return err(failure);
      });
      // Native owner failures are Results, unlike a rejected Chokidar close.
      Object.assign(parent, { close });
      await refresh.closeSkillsWatchers();
      expect(close).toHaveBeenCalledOnce();
      const other = path.join(ancestor, "third", "skills");
      // This missing target subscribes to the exact failed shared parent.
      // An independently owned existing descendant is not quarantined by overlap.
      const before = watchMock.mock.calls.length;
      const request = { ...requests[0], config: { skills: { load: { extraDirs: [other] } } } };
      refresh.ensureSkillsWatcher(request);
      await waitForSkillsWatcherTurn();
      expect(
        watchMock.mock.calls
          .slice(before)
          .some(
            ([root, options]) => root === ancestor.replaceAll("\\", "/") && options.depth === 0,
          ),
      ).toBe(false);
      expect(refresh.reconcileSkillsWatcherCoverage(request)).toBe(false);
    },
  );

  it.each(["active", "pending", "retired"] as const)(
    "waits for its held %s generation before admitting a replacement and late subscriber",
    async (generation) => {
      const { left, requests, parent, write } = await family(true);
      const active = watchForSkillRoot(left).watcher;
      const expanded = path.join(left, "expanded");
      await fs.mkdir(expanded);
      active.emit("all", "addDir", expanded);
      const pending = watchForSkillRoot(left).watcher;
      expect(pending).not.toBe(active);
      const held = generation === "pending" ? pending : active;
      const originalClose = held.close.getMockImplementation()!;
      const release = createDeferredCore();
      held.close.mockImplementationOnce(async () => {
        await originalClose();
        await release.promise;
      });
      const admissions = () =>
        watchMock.mock.calls.filter(
          ([root, options]) => root === left.replaceAll("\\", "/") && options.depth > 0,
        ).length;
      try {
        if (generation === "retired") {
          pending.emit("ready");
          expect(held.closed).toBe(true);
          expect(pending.closed).toBe(false);
        }
        parent.emit("error", Object.assign(new Error("ancestor lost"), { code: "EIO" }));
        const before = admissions();
        const late = {
          ...requests[0],
          workspaceDir: await fixture.createFixtureDirectory("held-late-owner"),
        };
        refresh.ensureSkillsWatcher(late);
        expect(admissions()).toBe(before);
        expect(refresh.reconcileSkillsWatcherCoverage(late)).toBe(false);
        release.resolve();
        await vi.waitFor(() => expect(admissions()).toBeGreaterThan(before));
        await readyAll();
        await Promise.resolve();
        await readyAll();
        expect(refresh.reconcileSkillsWatcherCoverage(late)).toBe(true);
        const { loadWorkspaceSkills } = await import("../loading/workspace-skill-loader.js");
        const read = () =>
          loadWorkspaceSkills(late.workspaceDir, late).find((entry) => entry.skill.name === "proof")
            ?.skill.description;
        expect(read()).toBe("Left original");
        const version = getSkillsSourceVersion(late.workspaceDir);
        await write(left, "Recovered late-owner content");
        vi.useFakeTimers();
        watchForSkillRoot(left).watcher.emit("all", "change", path.join(left, "proof", "SKILL.md"));
        await vi.advanceTimersByTimeAsync(250);
        expect(getSkillsSourceVersion(late.workspaceDir)).toBeGreaterThan(version);
        expect(read()).toBe("Recovered late-owner content");
      } finally {
        release.resolve();
        await refresh.closeSkillsWatchers();
      }
    },
  );

  it.each(["unsubscribe", "shutdown", "capacity"] as const)(
    "cancels its held owner replacement on %s",
    async (action) => {
      // Native watch-capacity shutdown deliberately excludes pathname polling.
      if (action === "capacity") {
        vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
      }
      const { left, right, requests, parent } = await family(true);
      refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
      await readyAll();
      const healthy = watchForSkillRoot(path.join(fixture.workspaceDir, "skills")).watcher;
      const active = watchForSkillRoot(left).watcher;
      const originalClose = active.close.getMockImplementation()!;
      const release = createDeferredCore();
      active.close.mockImplementationOnce(async () => {
        await originalClose();
        await release.promise;
      });
      const admissions = () => watcherAdmissions(left, false).length;
      let closing: Promise<void> | undefined;
      try {
        const before = admissions();
        const sibling = watchForSkillRoot(right).watcher;
        parent.emit("error", Object.assign(new Error("ancestor lost"), { code: "EIO" }));
        if (action === "unsubscribe") {
          refresh.ensureSkillsWatcher({
            ...requests[0],
            config: { skills: { load: { watch: false } } },
          });
        } else if (action === "shutdown") {
          closing = refresh.closeSkillsWatchers();
        } else {
          healthy.emit(
            "error",
            Object.assign(new Error("native capacity exhausted"), {
              code: "ENOSPC",
              syscall: "watch",
            }),
          );
          expect(healthy.closed).toBe(true);
        }
        expect(admissions()).toBe(before);
        release.resolve();
        if (action === "unsubscribe") {
          await vi.waitFor(() => expect(watchForSkillRoot(right).watcher).not.toBe(sibling));
        } else if (action === "shutdown") {
          await closing;
        } else {
          // Every mocked close is now resolved. Cross the microtask checkpoint
          // without disposing subscriptions, so capacity alone must block rearm.
          await waitForSkillsWatcherTurn();
          const version = getSkillsSourceVersion(requests[0].workspaceDir);
          refresh.ensureSkillsWatcher(requests[0]);
          expect(getSkillsSourceVersion(requests[0].workspaceDir)).toBeGreaterThan(version);
        }
        expect(admissions()).toBe(before);
      } finally {
        release.resolve();
        await closing;
        await refresh.closeSkillsWatchers();
      }
    },
  );
});
