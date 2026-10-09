import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { getSkillsSourceVersion } from "./refresh-state.js";
import { pathWatchers } from "./refresh-watch-registry.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
  waitForSkillsWatcherTurn,
} from "./refresh.watcher.test-support.js";
const observer = createSkillsWatcherMock();
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watchMock }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));
const fixture = useSkillsWatcherFixture(observer);
const refresh = await import("./refresh.js");
// Complete worker admission during test-file setup, before timing the recovery behavior.
const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");

it("invalidates before joined retirement, retries once, and restores availability", async () => {
  const params = { workspaceDir: fixture.workspaceDir };
  refresh.ensureSkillsWatcher(params);
  await observer.readyAll();
  const root = path.join(params.workspaceDir, "skills");
  const original = observer.forRoot(root);
  const retired = createDeferredCore();
  original.holdClose(retired.promise);
  const events = vi.fn();
  refresh.registerSkillsChangeListener(events);
  const before = getSkillsSourceVersion(params.workspaceDir);
  original.fail(new Error("lost coverage"));
  expect(getSkillsSourceVersion(params.workspaceDir)).toBeGreaterThan(before);
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ reason: "watch-unavailable" }));
  expect(refresh.reconcileSkillsWatcherCoverage(params)).toBe(false);
  await observer.started();
  expect(observer.forRoot(root, true)).toBe(original);
  retired.resolve();
  await original.close();
  await waitForSkillsWatcherTurn();
  await observer.started();
  const replacement = observer.forRoot(root);
  expect(replacement).not.toBe(original);
  expect(events.mock.calls.some(([event]) => event.reason === "watch-available")).toBe(false);
  await observer.readyAll();
  expect(refresh.reconcileSkillsWatcherCoverage(params)).toBe(true);
  expect(events.mock.calls.filter(([event]) => event.reason === "watch-available")).toHaveLength(1);
});

it("settles a deeper subscriber's scope update when replacement startup fails", async () => {
  const workspaceDir = fixture.workspaceDir;
  const root = await fixture.createFixtureDirectory("shared-source");
  refresh.ensureSkillsWatcher({
    workspaceDir,
    sourcePlan: {
      ...resolveWorkspaceSkillSourcePlan(workspaceDir, { workspaceOnly: true }),
      roots: [{ dir: root, source: "openclaw-extra", tier: "extra" }],
    },
  });
  await observer.readyAll();
  const original = observer.forRoot(root);
  original.fail(new Error("first scan failed"));
  await original.close();
  await waitForSkillsWatcherTurn();
  await observer.started();
  const retry = observer.forRoot(root);
  const state = pathWatchers.get(root)!;
  const initialDepth = state.depth;
  const refreshScope = state.refreshScope;
  // Bound a broken recursive retry so the regression fails instead of starving the event loop.
  const scopeUpdates = vi
    .spyOn(state, "refreshScope")
    .mockResolvedValue(undefined)
    .mockImplementationOnce(refreshScope);
  const peer = await fixture.createFixtureDirectory("peer");
  refresh.ensureSkillsWatcher({
    workspaceDir: peer,
    sourcePlan: {
      ...resolveWorkspaceSkillSourcePlan(peer, { workspaceOnly: true }),
      roots: [{ dir: root, source: "openclaw-workspace", tier: "workspace" }],
    },
  });
  expect(state.depth).toBeGreaterThan(initialDepth);
  expect(scopeUpdates).toHaveBeenCalledOnce();
  retry.fail(new Error("replacement scan failed"));
  await scopeUpdates.mock.results[0]!.value;
  expect(scopeUpdates).toHaveBeenCalledOnce();
  expect(state.failed).toBe(true);
  expect(observer.forRoot(root, true)).toBe(retry);
  expect(retry.close).not.toHaveBeenCalled();
});

it("withholds deeper coverage while resolving the expanded scope", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const workspaceDir = fixture.workspaceDir;
  const root = await fixture.createFixtureDirectory("shared-source");
  const sourcePlan = resolveWorkspaceSkillSourcePlan(workspaceDir, { workspaceOnly: true });
  refresh.ensureSkillsWatcher({
    workspaceDir,
    sourcePlan: {
      ...sourcePlan,
      roots: [{ dir: root, source: "openclaw-extra", tier: "extra" }],
    },
  });
  await observer.readyAll();
  const observed = observer.forRoot(root);
  const scopeUpdates = vi.spyOn(observed.subscription, "setScopes");
  const updates = vi.spyOn(pathWatchers.get(root)!, "refreshScope");
  const planning = await import("./refresh-observation-source.js");
  const original = vi.mocked(planning.skillsObservationScope).getMockImplementation()!;
  const entered = createDeferredCore();
  const release = createDeferredCore();
  vi.mocked(planning.skillsObservationScope).mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  const deeper = {
    workspaceDir,
    sourcePlan: {
      ...sourcePlan,
      roots: [{ dir: root, source: "openclaw-workspace", tier: "workspace" as const }],
    },
  };
  try {
    expect(refresh.reconcileSkillsWatcherCoverage(deeper)).toBe(false);
    await entered.promise;
    expect(refresh.reconcileSkillsWatcherCoverage(deeper)).toBe(false);
    expect(scopeUpdates).not.toHaveBeenCalled();
    release.resolve();
    await updates.mock.results[0]!.value;
    expect(scopeUpdates).toHaveBeenCalledOnce();
    expect(refresh.reconcileSkillsWatcherCoverage(deeper)).toBe(true);
  } finally {
    release.resolve();
  }
});

it.each(["unsubscribe", "shutdown", "re-ensure"] as const)(
  "retains plan ownership when failure publication triggers %s",
  async (action) => {
    const params = { workspaceDir: fixture.workspaceDir };
    refresh.ensureSkillsWatcher(params);
    await observer.readyAll();
    const original = observer.forRoot(path.join(params.workspaceDir, "skills"));
    let shutdown: Promise<void> | undefined;
    const off = refresh.registerSkillsChangeListener((event) => {
      if (event.reason !== "watch-unavailable") {
        return;
      }
      off();
      if (action === "shutdown") {
        shutdown = refresh.closeSkillsWatchers();
      } else {
        refresh.ensureSkillsWatcher(
          action === "unsubscribe"
            ? { ...params, config: { skills: { load: { watch: false } } } }
            : params,
        );
      }
    });
    original.fail(new Error("lost"));
    await original.close();
    await shutdown;
    await waitForSkillsWatcherTurn();
    await observer.started();
    if (action === "re-ensure") {
      await observer.readyAll();
      expect(refresh.reconcileSkillsWatcherCoverage(params)).toBe(true);
    } else {
      expect(observer.subscriptions.every((entry) => entry.closed)).toBe(true);
    }
  },
);

it("keeps healthy sibling coverage and refreshes actual content while recovery is held", async () => {
  const params = { workspaceDir: fixture.workspaceDir, config: { plugins: { enabled: false } } };
  const write = (description: string) =>
    writeSkill({ dir: path.join(params.workspaceDir, "skills/guide"), name: "guide", description });
  await write("Before outage");
  const first = await resolveReusableWorkspaceSkillSnapshot(params);
  await observer.readyAll();
  const original = observer.forRoot(path.join(params.workspaceDir, "skills"));
  const held = createDeferredCore();
  original.holdClose(held.promise);
  try {
    original.fail(new Error("lost"));
    await write("Edited before retirement completed");
    const next = await resolveReusableWorkspaceSkillSnapshot({
      ...params,
      existingSnapshot: first.snapshot,
    });
    expect(next.snapshot.prompt).toContain("Edited before retirement completed");
    expect(refresh.reconcileSkillsWatcherCoverage(params)).toBe(false);
  } finally {
    held.resolve();
    await original.close();
  }
});

it("joins previously retired subscriptions at shutdown", async () => {
  refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.readyAll();
  const original = observer.forRoot(path.join(fixture.workspaceDir, "skills"));
  const held = createDeferredCore();
  original.holdClose(held.promise);
  refresh.ensureSkillsWatcher({
    workspaceDir: fixture.workspaceDir,
    config: { skills: { load: { watch: false } } },
  });
  const seen = vi.fn();
  refresh.registerSkillsChangeListener(seen);
  let closed = false;
  const closing = refresh.closeSkillsWatchers().then(() => {
    closed = true;
  });
  await waitForSkillsWatcherTurn();
  expect(closed).toBe(false);
  expect(seen).not.toHaveBeenCalled();
  held.resolve();
  await closing;
  expect(closed).toBe(true);
});

it("publishes initial discovery only after all logical observations are ready", async () => {
  const workspaceDir = fixture.workspaceDir;
  refresh.ensureSkillsWatcher({ workspaceDir });
  await observer.started();
  const held = observer.forRoot(path.join(workspaceDir, "skills"));
  const before = getSkillsSourceVersion(workspaceDir);
  for (const entry of observer.subscriptions) {
    if (entry !== held) {
      entry.settleReady();
    }
  }
  await waitForSkillsWatcherTurn();
  expect(getSkillsSourceVersion(workspaceDir)).toBe(before);
  held.settleReady();
  await waitForSkillsWatcherTurn();
  expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(before);
  const settled = getSkillsSourceVersion(workspaceDir);
  held.settleReady();
  await waitForSkillsWatcherTurn();
  expect(getSkillsSourceVersion(workspaceDir)).toBe(settled);
});

it("does not revalidate base consumers when delayed execution coverage becomes ready", async () => {
  const workspaceDir = fixture.workspaceDir;
  refresh.ensureSkillsWatcher({ workspaceDir });
  await observer.readyAll();
  const before = getSkillsSourceVersion(workspaceDir);
  const executionWorkspaceDir = await fixture.createFixtureDirectory("execution");
  refresh.ensureSkillsWatcher({ workspaceDir, executionWorkspaceDir });
  await observer.started();
  const executionBefore = getSkillsSourceVersion(workspaceDir, { executionWorkspaceDir });
  await observer.readyAll();
  expect(getSkillsSourceVersion(workspaceDir)).toBe(before);
  expect(getSkillsSourceVersion(workspaceDir, { executionWorkspaceDir })).toBeGreaterThan(
    executionBefore,
  );
});

it("invalidates healthy ready roots even when a sibling initial scan has failed", async () => {
  const workspaceDir = fixture.workspaceDir;
  refresh.ensureSkillsWatcher({ workspaceDir });
  await observer.started();
  const failed = observer.forRoot(path.join(workspaceDir, "skills"));
  failed.fail(new Error("scan failed"));
  await failed.close();
  await waitForSkillsWatcherTurn();
  await observer.started();
  const retry = observer.forRoot(path.join(workspaceDir, "skills"));
  retry.fail(new Error("retry failed"));
  for (const entry of observer.subscriptions) {
    if (entry !== retry) {
      entry.settleReady();
    }
  }
  await waitForSkillsWatcherTurn();
  const healthy = observer.forRoot(path.join(workspaceDir, ".agents", "skills"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const before = getSkillsSourceVersion(workspaceDir);
  healthy.dirty();
  await vi.advanceTimersByTimeAsync(250);
  expect(getSkillsSourceVersion(workspaceDir)).toBeGreaterThan(before);
});
