import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
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
const fixture = useSkillsWatcherFixture(observer, {
  expectedShutdownFailure: true,
  resetModulesAfterCleanup: true,
});
let refresh: typeof import("./refresh.js");
beforeEach(async () => {
  vi.resetModules();
  await observer.trackPlanning();
  refresh = await import("./refresh.js");
});

it("quarantines actual teardown failure and keeps shutdown rejected without rearming", async () => {
  refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.readyAll();
  const root = path.join(fixture.workspaceDir, "skills");
  const original = observer.forRoot(root);
  const failure = new Error("physical termination failed");
  const barrier = createDeferredCore();
  original.holdClose(barrier.promise);
  original.fail(new Error("observation failed"));
  barrier.reject(failure);
  await expect(original.close()).rejects.toBe(failure);
  await waitForSkillsWatcherTurn();
  refresh.ensureSkillsWatcher({ workspaceDir: fixture.workspaceDir });
  await observer.started();
  expect(observer.forRoot(root, true)).toBe(original);
  await expect(refresh.closeSkillsWatchers()).rejects.toThrow("Skills watcher shutdown failed");
  // Failed retirement is deliberately terminal, including the fixture cleanup.
});
