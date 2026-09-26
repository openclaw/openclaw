import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
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
// Capacity degradation persists until shutdown; each case owns its module state.
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
it.each(["EMFILE", "ENFILE", "watch-limit"])(
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

it.each(["watch-limit", "EMFILE", "ENFILE"])(
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
