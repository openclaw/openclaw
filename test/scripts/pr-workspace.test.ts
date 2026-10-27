import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyPrWrapperSources, createIndependentPrFixtureEnv } from "./pr-wrapper.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("scripts/pr workspace preflight", () => {
  it.each(["canonical", "linked", "materialized"])(
    "reports physical artifact paths without dependencies or PR state changes from %s code",
    (route) => {
      const root = realpathSync(temps.make("pr-workspace-"));
      const owner = join(root, "owner");
      const caller = join(root, "task");
      const artifacts = join(caller, "native-artifacts");
      const env = {
        ...createIndependentPrFixtureEnv(),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        TMPDIR: root,
        // Dependency selection must not run for this path-only command.
        OPENCLAW_PR_TOOLING_ROOT: join(root, "missing-dependencies"),
      };
      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim();
      copyPrWrapperSources(owner);
      git(owner, "init", "-q", "-b", "main");
      git(owner, "config", "core.hooksPath", "/dev/null");
      git(owner, "config", "commit.gpgsign", "false");
      git(owner, "add", ".");
      git(owner, "commit", "-qm", "Trusted wrapper");
      git(owner, "update-ref", "refs/remotes/origin/main", "HEAD");
      git(owner, "worktree", "add", "-q", "-b", "task", caller, "HEAD");
      if (route === "materialized") {
        // Neither checkout can supply the anchor; exercise real extraction.
        for (const cwd of [owner, caller]) {
          appendFileSync(join(cwd, "scripts/pr-lib/worktree.sh"), `\n# checkout drift in ${cwd}\n`);
          git(cwd, "add", "scripts/pr-lib/worktree.sh");
          git(cwd, "commit", "-qm", "Checkout drift");
        }
      }
      const refs = git(owner, "show-ref");
      const run = () =>
        spawnSync(
          join(route === "canonical" ? owner : caller, "scripts/pr"),
          ["workspace", "123"],
          {
            cwd: caller,
            env,
            encoding: "utf8",
            timeout: 15_000,
          },
        );
      for (const redirected of [false, true]) {
        if (redirected) {
          mkdirSync(artifacts);
          symlinkSync(artifacts, join(owner, ".worktrees"), "dir");
        }
        const result = run();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        if (route === "materialized") {
          expect(result.stderr).toContain("running wrapper code materialized from");
        }
        const worktree = join(redirected ? artifacts : join(owner, ".worktrees"), "pr-123");
        expect(JSON.parse(result.stdout)).toEqual({
          canonicalRoot: owner,
          commonGitDir: join(owner, ".git"),
          worktree,
          artifactDirectory: join(worktree, ".local"),
          reviewJson: join(worktree, ".local/review.json"),
        });
        expect(git(owner, "show-ref")).toBe(refs);
        expect(existsSync(worktree)).toBe(false);
        expect(existsSync(join(owner, ".local"))).toBe(false);
        expect(existsSync(join(owner, "node_modules"))).toBe(false);
      }
    },
  );
});
