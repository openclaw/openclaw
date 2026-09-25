import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillSnapshot } from "../types.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
} from "./refresh.watcher.test-support.js";
const observer = createSkillsWatcherMock();
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watchMock }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));
// A failed physical close must retain its process budget. Isolate process state
// instead of adding a production reset that could forgive leaked workers.
const fixtureOptions = { expectedShutdownFailure: false };
beforeEach(() => {
  vi.resetModules();
  fixtureOptions.expectedShutdownFailure = false;
});
const fixture = useSkillsWatcherFixture(observer, fixtureOptions);
let refreshModule: typeof import("./refresh.js");
let getSkillsSnapshotVersion: typeof import("./refresh-state.js").getSkillsSnapshotVersion;
beforeEach(async () => {
  refreshModule = await import("./refresh.js");
  ({ getSkillsSnapshotVersion } = await import("./refresh-state.js"));
});
const createFixtureDirectory = (name: string) => fixture.createFixtureDirectory(name);
it.each(["EMFILE", "ENFILE", "ENOSPC"])(
  "refreshes shared skill snapshots during preparation after native %s",
  async (code) => {
    const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
    const sharedRoot = await createFixtureDirectory("shared/skills");
    const secondWorkspace = await createFixtureDirectory("second-workspace");
    const skillDir = path.join(sharedRoot, "capacity-proof");
    const config = { skills: { load: { extraDirs: [sharedRoot] } } };
    const resolveSnapshot = async (workspaceDir: string, existingSnapshot?: SkillSnapshot) =>
      (
        await resolveReusableWorkspaceSkillSnapshot({
          workspaceDir,
          config,
          skillFilter: ["capacity-proof", "added-proof"],
          existingSnapshot,
        })
      ).snapshot;
    await writeSkill({
      dir: skillDir,
      name: "capacity-proof",
      description: "Amber lantern catalog description.",
    });
    const first = await resolveSnapshot(fixture.workspaceDir);
    const second = await resolveSnapshot(secondWorkspace);
    expect(first.prompt).toContain("Amber lantern catalog description.");
    expect(second.prompt).toContain("Amber lantern catalog description.");
    await observer.readyAll();
    const failedWatcher = observer.forRoot(sharedRoot);
    failedWatcher.fail(new Error(code), { operation: "watch", code });
    const watcherCount = observer.subscriptions.length;
    expect(observer.subscriptions.every((watcher) => watcher.closed)).toBe(true);
    // Late health delivery cannot undo capacity degradation.
    expect(() => {
      failedWatcher.fail(new Error("late scan"), { operation: "scan", code: "EACCES" });
    }).not.toThrow();

    await writeSkill({
      dir: skillDir,
      name: "capacity-proof",
      description: "Cobalt heron catalog description.",
    });
    const editedFirst = await resolveSnapshot(fixture.workspaceDir, first);
    const editedSecond = await resolveSnapshot(secondWorkspace, second);
    for (const snapshot of [editedFirst, editedSecond]) {
      expect(snapshot.prompt).toContain("Cobalt heron catalog description.");
      expect(snapshot.prompt).not.toContain("Amber lantern catalog description.");
    }

    await writeSkill({
      dir: path.join(sharedRoot, "added-proof"),
      name: "added-proof",
      description: "Silver otter new catalog entry.",
    });
    expect((await resolveSnapshot(fixture.workspaceDir, editedFirst)).prompt).toContain(
      "Silver otter new catalog entry.",
    );
    expect((await resolveSnapshot(secondWorkspace, editedSecond)).prompt).toContain(
      "Silver otter new catalog entry.",
    );
    const lateWorkspace = await createFixtureDirectory("late-workspace");
    expect((await resolveSnapshot(lateWorkspace)).prompt).toContain(
      "Silver otter new catalog entry.",
    );
    expect(observer.subscriptions).toHaveLength(watcherCount);

    const disabled = {
      workspaceDir: fixture.workspaceDir,
      config: { skills: { load: { watch: false } } },
    };
    refreshModule.ensureSkillsWatcher(disabled);
    const disabledVersion = getSkillsSnapshotVersion(fixture.workspaceDir);
    refreshModule.ensureSkillsWatcher(disabled);
    expect(getSkillsSnapshotVersion(fixture.workspaceDir)).toBe(disabledVersion);
    expect(observer.subscriptions).toHaveLength(watcherCount);

    await refreshModule.closeSkillsWatchers();
    refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
    await observer.readyAll();
    expect(observer.forRoot(sharedRoot).closed).toBe(false);
  },
);

it.each(["ENOSPC", "EMFILE", "ENFILE"])(
  "does not globally degrade for scan-side %s",
  async (code) => {
    const workspaceDir = fixture.workspaceDir;
    const sibling = await fixture.createFixtureDirectory("sibling");
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    refreshModule.ensureSkillsWatcher({ workspaceDir: sibling });
    await observer.readyAll();
    const healthy = observer.forRoot(path.join(sibling, "skills"));
    const failed = observer.forRoot(path.join(workspaceDir, "skills"));
    failed.fail(new Error(code), { operation: "scan", code });
    await failed.close();
    await observer.readyAll();
    expect(healthy.closed).toBe(false);
    expect(observer.forRoot(path.join(workspaceDir, "skills"))).not.toBe(failed);
    expect(refreshModule.reconcileSkillsWatcherCoverage({ workspaceDir: sibling })).toBe(true);
  },
);

async function workerPlans() {
  const plans = new Map<string, string[]>();
  const planner = await import("./refresh-watch-targets.js");
  vi.spyOn(planner, "resolveSkillsWatchTargets").mockImplementation((workspaceDir) => ({
    signature: workspaceDir,
    targets: (plans.get(workspaceDir) ?? []).map((target) => ({
      path: target,
      authorityPath: fixture.root,
      depth: 6,
    })),
  }));
  return plans;
}
function syntheticTargets(count: number) {
  return Array.from({ length: count }, (_, index) => path.join(fixture.root, "target-" + index));
}

it("shares the worker ceiling across workspaces and refreshes denied skills during preparation", async () => {
  const plans = await workerPlans();
  const admitted = syntheticTargets(16);
  plans.set(fixture.workspaceDir, admitted);
  refreshModule.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.readyAll();
  const shared = observer.forRoot(admitted[0]!);
  const second = await createFixtureDirectory("second-workspace");
  const deniedRoot = await createFixtureDirectory("second-workspace/skills");
  plans.set(second, [admitted[0]!, deniedRoot]);
  const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
  const skillDir = path.join(deniedRoot, "worker-budget-proof");
  const write = (description: string) =>
    writeSkill({
      dir: skillDir,
      name: "worker-budget-proof",
      description,
    });
  const params = { workspaceDir: second, config: {}, skillFilter: ["worker-budget-proof"] };
  await write("Before worker admission denial");
  const first = await resolveReusableWorkspaceSkillSnapshot(params);
  await observer.readyAll();
  expect(first.snapshot.prompt).toContain("Before worker admission denial");
  expect(observer.subscriptions).toHaveLength(16);
  expect(
    observer.subscriptions.every((entry) => !entry.closed && entry.options.mode === "node"),
  ).toBe(true);
  expect(refreshModule.reconcileSkillsWatcherCoverage(params)).toBe(false);
  await observer.readyAll();
  await write("Edited without a watch worker");
  const edited = await resolveReusableWorkspaceSkillSnapshot({
    ...params,
    existingSnapshot: first.snapshot,
  });
  expect(edited.snapshot.prompt).toContain("Edited without a watch worker");
  expect(edited.snapshot.prompt).not.toContain("Before worker admission denial");
  await observer.readyAll();
  expect(observer.subscriptions).toHaveLength(16);

  // The shared target keeps its worker; release the other workspace's exclusive
  // targets and let the next preparation retry the denied Root.
  refreshModule.ensureSkillsWatcher({
    workspaceDir: fixture.workspaceDir,
    config: { skills: { load: { watch: false } } },
  });
  await observer.started();
  refreshModule.ensureSkillsWatcher(params);
  await observer.readyAll();
  expect(observer.subscriptions).toHaveLength(17);
  expect(observer.forRoot(admitted[0]!)).toBe(shared);
  expect(refreshModule.reconcileSkillsWatcherCoverage(params)).toBe(true);
});

it("does not release a retiring worker until physical close fulfills", async () => {
  const plans = await workerPlans();
  const targets = syntheticTargets(16);
  plans.set(fixture.workspaceDir, targets);
  refreshModule.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.readyAll();
  const held = observer.forRoot(targets[0]!);
  const physical = createDeferredCore();
  held.holdClose(physical.promise);
  const registry = await import("./refresh-watch-registry.js");
  const retiring = registry.pathWatchers.get(targets[0]!)!;
  const second = await createFixtureDirectory("late-workspace");
  plans.set(second, [path.join(second, "skills")]);
  try {
    plans.set(fixture.workspaceDir, targets.slice(1));
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
    refreshModule.ensureSkillsWatcher({ workspaceDir: second });
    await observer.readyAll();
    expect(held.close).toHaveBeenCalledOnce();
    expect(observer.subscriptions).toHaveLength(16);
    expect(refreshModule.reconcileSkillsWatcherCoverage({ workspaceDir: second })).toBe(false);
  } finally {
    physical.resolve();
    await retiring.close();
  }
  refreshModule.ensureSkillsWatcher({ workspaceDir: second });
  await observer.readyAll();
  expect(observer.subscriptions).toHaveLength(17);
  expect(refreshModule.reconcileSkillsWatcherCoverage({ workspaceDir: second })).toBe(true);
});

it.each(["close", "health"])(
  "joins synchronous construction-time %s without releasing early",
  async (action) => {
    const plans = await workerPlans();
    const targets = syntheticTargets(16);
    plans.set(fixture.workspaceDir, targets.slice(0, 15));
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
    await observer.readyAll();
    const registry = await import("./refresh-watch-registry.js");
    const physical = createDeferredCore();
    const construct = observer.watchMock.getMockImplementation()!;
    let closing: Promise<void> | undefined;
    observer.watchMock.mockImplementationOnce((authority, options) => {
      const subscription = construct(authority, options);
      const entry = observer.subscriptions.at(-1)!;
      entry.holdClose(physical.promise);
      const state = registry.pathWatchers.get(targets[15]!)!;
      if (action === "health") {
        entry.fail(new Error("startup failure"));
      }
      closing = state.close();
      const close = entry.close.getMockImplementation()!;
      entry.close.mockImplementation(() => {
        expect(state.close()).toBe(closing);
        return close();
      });
      return subscription;
    });
    plans.set(fixture.workspaceDir, targets);
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
    await observer.started();
    const old = observer.subscriptions.at(-1)!;
    let joined = false;
    void closing!.then(() => {
      joined = true;
    });
    const second = await createFixtureDirectory("startup-peer");
    plans.set(second, [path.join(second, "skills")]);
    try {
      refreshModule.ensureSkillsWatcher({ workspaceDir: second });
      await observer.readyAll();
      expect(joined).toBe(false);
      expect(old.close).toHaveBeenCalledOnce();
      expect(observer.subscriptions).toHaveLength(16);
    } finally {
      physical.resolve();
      await closing;
    }
    if (action === "health") {
      await observer.readyAll();
      expect(observer.forRoot(targets[15]!).authority).toBe(old.authority);
    } else {
      refreshModule.ensureSkillsWatcher({ workspaceDir: second });
      await observer.readyAll();
      expect(refreshModule.reconcileSkillsWatcherCoverage({ workspaceDir: second })).toBe(true);
    }
    expect(observer.subscriptions).toHaveLength(17);
  },
);

it("does not charge explicit polling subscriptions to the Node worker ceiling", async () => {
  const plans = await workerPlans();
  plans.set(fixture.workspaceDir, syntheticTargets(20));
  vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
  refreshModule.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.readyAll();
  expect(observer.subscriptions).toHaveLength(20);
  expect(observer.subscriptions.every((entry) => entry.options.mode === "poll")).toBe(true);
  vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
  const second = await createFixtureDirectory("native-workspace");
  plans.set(
    second,
    Array.from({ length: 17 }, (_, index) => path.join(second, "target-" + index)),
  );
  refreshModule.ensureSkillsWatcher({ workspaceDir: second });
  await observer.readyAll();
  expect(observer.subscriptions.filter((entry) => entry.options.mode === "node")).toHaveLength(16);
});

it.each(["throw", "reject"])("retains worker admission after actual close %s", async (kind) => {
  fixtureOptions.expectedShutdownFailure = true;
  const plans = await workerPlans();
  const targets = syntheticTargets(16);
  plans.set(fixture.workspaceDir, targets);
  refreshModule.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.readyAll();
  const failed = observer.forRoot(targets[0]!);
  const error = new Error("physical retirement failed");
  if (kind === "throw") {
    failed.close.mockImplementation(() => {
      throw error;
    });
  } else {
    failed.holdClose(Promise.reject(error));
  }
  const registry = await import("./refresh-watch-registry.js");
  const failedState = registry.pathWatchers.get(targets[0]!)!;
  plans.set(fixture.workspaceDir, targets.slice(1));
  refreshModule.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  const closing = failedState.close();
  await expect(closing).rejects.toThrow("Skills observation retirement failed");
  expect(failedState.close()).toBe(closing);
  const second = await createFixtureDirectory("failed-close-peer");
  plans.set(second, [path.join(second, "skills")]);
  refreshModule.ensureSkillsWatcher({ workspaceDir: second });
  await observer.readyAll();
  expect(observer.subscriptions).toHaveLength(16);
  expect(refreshModule.reconcileSkillsWatcherCoverage({ workspaceDir: second })).toBe(false);
});

it("releases constructor rejection without a worker and joins shutdown during initial admission", async () => {
  const plans = await workerPlans();
  const targets = syntheticTargets(16);
  plans.set(fixture.workspaceDir, targets.slice(0, 1));
  observer.watchMock.mockImplementationOnce(() => {
    throw new Error("invalid watch options");
  });
  refreshModule.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.readyAll();
  // Whether recovery has started or not, shutdown joins its admission/retirement.
  await refreshModule.closeSkillsWatchers();
  observer.subscriptions.length = 0;
  plans.set(fixture.workspaceDir, targets);
  refreshModule.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.readyAll();
  expect(observer.subscriptions).toHaveLength(16);
  expect(refreshModule.reconcileSkillsWatcherCoverage({ workspaceDir: fixture.workspaceDir })).toBe(
    true,
  );
});
