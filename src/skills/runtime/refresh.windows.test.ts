import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
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
const fixture = useSkillsWatcherFixture(observer);
const refresh = await import("./refresh.js");

// Actual Windows path semantics only. OS notification case/8.3/delete-pending
// behavior must be qualified by the installed library, not process.platform mocks.
it.runIf(process.platform === "win32")(
  "keeps a missing drive child anchored absolutely",
  async () => {
    const driveRoot = path.parse(fixture.root).root;
    const missingRoot = path.join(driveRoot, path.basename(fixture.root) + "-missing");
    expect(fs.existsSync(missingRoot)).toBe(false);
    refresh.ensureSkillsWatcher({
      workspaceDir: fixture.workspaceDir,
      config: { skills: { load: { extraDirs: [missingRoot] } } },
    });
    await observer.readyAll();
    const subscription = observer.forRoot(missingRoot);
    expect(path.isAbsolute(subscription.authority.rootDir)).toBe(true);
    expect(subscription.authority.rootDir).toBe(driveRoot);
    expect(path.isAbsolute(subscription.options.scopes[0]!.path)).toBe(false);
  },
);
