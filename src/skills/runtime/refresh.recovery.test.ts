import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { getSkillsSourceVersion } from "./refresh-state.js";
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

it("invalidates before joined retirement, retries once under the exact admitted Root, and restores availability", async () => {
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
  expect(replacement.authority).toBe(original.authority);
  expect(events.mock.calls.some(([event]) => event.reason === "watch-available")).toBe(false);
  await observer.readyAll();
  expect(refresh.reconcileSkillsWatcherCoverage(params)).toBe(true);
  expect(events.mock.calls.filter(([event]) => event.reason === "watch-available")).toHaveLength(1);
  const after = getSkillsSourceVersion(params.workspaceDir);
  original.dirty();
  original.fail(new Error("late failure"));
  expect(getSkillsSourceVersion(params.workspaceDir)).toBe(after);
});

it("does not automatically loop after its one recovery attempt fails", async () => {
  const params = { workspaceDir: fixture.workspaceDir };
  const root = path.join(params.workspaceDir, "skills");
  refresh.ensureSkillsWatcher(params);
  await observer.readyAll();
  const original = observer.forRoot(root);
  original.fail(new Error("first"));
  await original.close();
  await waitForSkillsWatcherTurn();
  await observer.started();
  const retry = observer.forRoot(root);
  retry.fail(new Error("second"));
  await waitForSkillsWatcherTurn();
  expect(observer.forRoot(root, true)).toBe(retry);
  expect(retry.close).not.toHaveBeenCalled();
  refresh.ensureSkillsWatcher(params);
  await retry.close();
  await waitForSkillsWatcherTurn();
  await observer.readyAll();
  expect(observer.forRoot(root).authority).toBe(original.authority);
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
      expect(observer.forRoot(path.join(params.workspaceDir, "skills")).authority).toBe(
        original.authority,
      );
    } else {
      expect(observer.subscriptions.every((entry) => entry.closed)).toBe(true);
    }
  },
);

it("keeps healthy sibling coverage and refreshes actual content while recovery is held", async () => {
  const params = { workspaceDir: fixture.workspaceDir, config: { plugins: { enabled: false } } };
  const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
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

it("joins retired subscriptions at shutdown and ignores post-retirement hints", async () => {
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
  original.dirty();
  await waitForSkillsWatcherTurn();
  expect(closed).toBe(false);
  expect(seen).not.toHaveBeenCalled();
  held.resolve();
  await closing;
  expect(closed).toBe(true);
});

it.each(["close", "health"] as const)(
  "joins synchronous construction-time %s before retirement completes",
  async (action) => {
    const params = { workspaceDir: fixture.workspaceDir };
    const root = path.join(params.workspaceDir, "skills");
    const registry = await import("./refresh-watch-registry.js");
    const physical = createDeferredCore();
    const construct = observer.watchMock.getMockImplementation()!;
    let closing: Promise<void> | undefined;
    let original: ReturnType<typeof observer.forRoot> | undefined;
    observer.watchMock.mockImplementation((authority, options) => {
      const subscription = construct(authority, options);
      if (path.resolve(authority.rootDir, options.scopes[0]!.path) !== root || original) {
        return subscription;
      }
      original = observer.subscriptions.at(-1)!;
      original.holdClose(physical.promise);
      const state = registry.pathWatchers.get(root)!;
      if (action === "health") {
        original.fail(new Error("startup observation failed"));
      }
      closing = state.close();
      const close = original.close.getMockImplementation()!;
      original.close.mockImplementation(() => {
        expect(state.close()).toBe(closing);
        return close();
      });
      return subscription;
    });
    try {
      refresh.ensureSkillsWatcher(params);
      await observer.started();
      expect(original).toBeDefined();
      let joined = false;
      void closing!.then(() => {
        joined = true;
      });
      refresh.ensureSkillsWatcher(params);
      await observer.started();
      expect(joined).toBe(false);
      expect(observer.forRoot(root, true)).toBe(original);
      expect(original!.close).toHaveBeenCalledOnce();
      physical.resolve();
      await closing;
      await waitForSkillsWatcherTurn();
      await observer.readyAll();
      expect(joined).toBe(true);
      if (action === "health") {
        const replacement = observer.forRoot(root);
        expect(replacement).not.toBe(original);
        expect(replacement.authority).toBe(original!.authority);
        expect(refresh.reconcileSkillsWatcherCoverage(params)).toBe(true);
      }
    } finally {
      physical.resolve();
      observer.watchMock.mockImplementation(construct);
    }
  },
);
