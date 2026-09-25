import path from "node:path";
import { expect, it, vi } from "vitest";
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
