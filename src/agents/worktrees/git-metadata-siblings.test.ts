import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { withWorktreeAllocationLease } from "./allocation.js";
import { git, initializeGitFixture } from "./git-fixture.test-support.js";
import { hydrateCommitObjects, missingCommitObjects } from "./object-hydration.js";
import { collectOrphanWorktreeBranches } from "./orphan-branches.js";
import { withWorktreeRunEnd } from "./run-end-lifecycle.js";

const temps = useStateDatabaseTempDirs();
afterEach(() => vi.unstubAllEnvs());

async function separateMetadata(repo: string, root: string, suffix: string) {
  const commonDir = path.join(root, `metadata${suffix}`);
  await fs.rename(path.join(repo, ".git"), commonDir);
  await fs.writeFile(path.join(repo, ".git"), `gitdir: ${commonDir}\n`);
  return commonDir;
}

it.skipIf(process.platform === "win32").each(["", " "])(
  "hydrates missing objects with common-directory suffix %j",
  async (suffix) => {
    const root = temps.make("worktree-hydration-metadata-");
    const source = await initializeGitFixture(root, "source", "base.txt", "base\n");
    const origin = path.join(root, "origin.git");
    const clone = path.join(root, "clone");
    await git(root, "clone", "--bare", source, origin);
    await git(origin, "config", "uploadpack.allowFilter", "true");
    await git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    await git(root, "clone", "--filter=blob:none", pathToFileURL(origin).href, clone);
    const commonDir = await separateMetadata(clone, root, suffix);
    await fs.writeFile(path.join(source, "later.txt"), "hydrate these bytes\n");
    await git(source, "add", "later.txt");
    await git(source, "commit", "-m", "new missing object");
    await git(source, "push", origin, "main");
    await git(clone, "fetch", "origin");
    vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
    const commit = await git(clone, "rev-parse", "origin/main");
    const missing = await missingCommitObjects(clone, commit);
    expect(missing).toHaveLength(1);
    await hydrateCommitObjects(clone, commit, missing);
    expect(await missingCommitObjects(clone, commit)).toEqual([]);
    expect(await git(clone, "show", `${commit}:later.txt`)).toBe("hydrate these bytes");
    expect(await fs.realpath(commonDir)).toBe(commonDir);
  },
);

it.skipIf(process.platform === "win32").each(["", " "])(
  "deletes an orphan branch with common-directory suffix %j",
  async (suffix) => {
    const root = temps.make("worktree-orphan-metadata-");
    const repo = await initializeGitFixture(root, "repo", "README.md", "keep source\n");
    const commonDir = await separateMetadata(repo, root, suffix);
    const head = await git(repo, "rev-parse", "HEAD");
    await git(repo, "branch", "openclaw/unused");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const result = await withWorktreeRunEnd(env, () =>
      withWorktreeAllocationLease({ env }, (guard) =>
        collectOrphanWorktreeBranches({ env, repoRoot: repo, ...guard }),
      ),
    );
    expect(result.branches).toEqual([{ branch: "openclaw/unused", outcome: "deleted" }]);
    expect(await git(repo, "branch", "--list", "openclaw/unused")).toBe("");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(await fs.readFile(path.join(repo, "README.md"), "utf8")).toBe("keep source\n");
    expect(await fs.realpath(commonDir)).toBe(commonDir);
  },
);
