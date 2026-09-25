import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { expect, it, vi } from "vitest";
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
// The service imports the shared owner before accepting individual turns.
const refresh = await import("./refresh.js");

it("does not retain the requesting turn context through initial observation or recovery", async () => {
  const caller = new AsyncLocalStorage<string>();
  const seen: Array<string | undefined> = [];
  const start = observer.watchMock.getMockImplementation()!;
  observer.watchMock.mockImplementation((authority, options) => {
    seen.push(caller.getStore());
    return start(authority, options);
  });
  try {
    const params = { workspaceDir: fixture.workspaceDir };
    caller.run("initial-turn", () => refresh.ensureSkillsWatcher(params));
    await observer.readyAll();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((context) => context === undefined)).toBe(true);
    const initialCount = seen.length;
    const original = observer.forRoot(path.join(fixture.workspaceDir, "skills"));
    caller.run("later-turn", () => original.fail(new Error("lost coverage")));
    await original.close();
    await waitForSkillsWatcherTurn();
    await observer.readyAll();
    expect(seen.length).toBeGreaterThan(initialCount);
    expect(seen.every((context) => context === undefined)).toBe(true);
    expect(observer.forRoot(path.join(fixture.workspaceDir, "skills")).authority).toBe(
      original.authority,
    );
  } finally {
    observer.watchMock.mockImplementation(start);
  }
});
