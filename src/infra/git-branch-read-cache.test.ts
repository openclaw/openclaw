import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { git, initializeGitFixture } from "../agents/worktrees/git-fixture.test-support.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { runGitReadOperation } from "./git-read-cache.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
});

it.each(["selected folder", "intermediate ancestor"])(
  "discovers Git initialized in the %s without changing parent refs",
  async (location) => {
    const root = tempDirs.make("openclaw-nested-branch-picker-");
    const outer = await initializeGitFixture(root, "outer", "README.md", "outer\n");
    await git(outer, "branch", "-m", "outer-main");
    await git(outer, "branch", "outer-side");
    const inner = path.join(outer, "packages", "widget");
    const selected = location === "selected folder" ? inner : path.join(inner, "src");
    await fs.mkdir(selected, { recursive: true });
    const read = () =>
      runGitReadOperation(
        { type: "repository.branches", input: { repoRoot: selected } },
        { snapshot: true },
      );
    await vi.waitFor(async () => {
      expect(await read()).toEqual({
        branches: [
          { name: "outer-main", kind: "local" },
          { name: "outer-side", kind: "local" },
        ],
        headBranch: "outer-main",
      });
    });

    await initializeGitFixture(path.dirname(inner), "widget", "README.md", "inner\n");
    await git(inner, "branch", "-m", "inner-main");
    await git(inner, "branch", "inner-side");
    await vi.waitFor(async () => {
      expect(await read()).toEqual({
        branches: [
          { name: "inner-main", kind: "local" },
          { name: "inner-side", kind: "local" },
        ],
        headBranch: "inner-main",
      });
    });
    await git(inner, "branch", "inner-new");
    await vi.waitFor(async () => {
      expect((await read()).branches).toContainEqual({ name: "inner-new", kind: "local" });
    });
    expect(await git(outer, "branch", "--format=%(refname:short)")).toBe("outer-main\nouter-side");
  },
);
