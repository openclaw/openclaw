import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runGit, type GitResult } from "../agents/worktrees/git.js";
import {
  loadSessionDiffBranchMetadata,
  resolveSessionDiffBase,
  resolveSessionDiffEmptyTree,
} from "./session-diff-revisions.js";

vi.mock("../agents/worktrees/git.js", () => ({ runGit: vi.fn() }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function gitResult(stdout: string, code = 0): GitResult {
  return {
    stdout,
    code,
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit",
    timeoutMs: 120_000,
  };
}

describe("empty-tree preparation", () => {
  beforeEach(() => vi.mocked(runGit).mockReset());

  it("reads the repository's current object format without retaining failures", async () => {
    vi.mocked(runGit).mockResolvedValueOnce(gitResult("", 128));
    await expect(resolveSessionDiffEmptyTree("repo")).resolves.toBeNull();
    vi.mocked(runGit).mockResolvedValueOnce(gitResult("format-specific-empty-tree\n"));
    await expect(resolveSessionDiffEmptyTree("repo")).resolves.toEqual({
      base: "format-specific-empty-tree",
    });
  });
});

describe("branch base resolution", () => {
  it.each([
    {
      name: "symbolic origin/HEAD before local and remote defaults",
      symbolicDefault: "origin/trunk",
      refs: ["origin/trunk", "main", "master", "origin/main", "origin/master"],
      expected: { base: "origin/trunk-base", baseRef: "trunk" },
    },
    {
      name: "local main before local master and remote defaults",
      symbolicDefault: null,
      refs: ["main", "master", "origin/main", "origin/master"],
      expected: { base: "main-base", baseRef: "main" },
    },
    {
      name: "local master before remote defaults",
      symbolicDefault: null,
      refs: ["master", "origin/main", "origin/master"],
      expected: { base: "master-base", baseRef: "master" },
    },
    {
      name: "remote main before remote master",
      symbolicDefault: null,
      refs: ["origin/main", "origin/master"],
      expected: { base: "origin/main-base", baseRef: "origin/main" },
    },
  ])("prefers $name", async ({ symbolicDefault, refs, expected }) => {
    const mergeBases = new Map(refs.map((ref) => [ref, `${ref}-base\n`]));
    const gitOut = async (_root: string, args: string[]) => {
      if (args[0] === "symbolic-ref") {
        return symbolicDefault;
      }
      const ref = (args[0] === "rev-parse" ? args.at(-1) : args[1])?.replace(/-sha$/, "");
      const mergeBase = ref ? mergeBases.get(ref) : undefined;
      if (!mergeBase) {
        return null;
      }
      return args[0] === "merge-base" ? mergeBase : `${ref}-sha\n`;
    };

    await expect(
      resolveSessionDiffBase({ branch: "feature", gitOut, head: "captured-head", root: "/repo" }),
    ).resolves.toEqual(expected);
  });

  it.each([undefined, "main", "master"])(
    "keeps HEAD for branch %s even when remote defaults exist",
    async (branch) => {
      const gitOut = async (_root: string, args: string[]) => {
        if (args[0] === "symbolic-ref") {
          return null;
        }
        if (args[0] === "rev-parse" && args.at(-1)?.startsWith("origin/")) {
          return "remote-sha\n";
        }
        if (args[0] === "merge-base" && args[1]?.startsWith("origin/")) {
          return "remote-base\n";
        }
        return null;
      };

      await expect(
        resolveSessionDiffBase({ branch, gitOut, head: "captured-head", root: "/repo" }),
      ).resolves.toEqual({
        base: "captured-head",
        baseRef: "HEAD",
      });
    },
  );

  it("keeps HEAD when no default ref resolves", async () => {
    await expect(
      resolveSessionDiffBase({
        branch: "feature",
        gitOut: async () => null,
        head: "captured-head",
        root: "/repo",
      }),
    ).resolves.toEqual({ base: "captured-head", baseRef: "HEAD" });
  });
});

describe("captured session history", () => {
  it("does not admit commits added after the checkout revision was captured", async () => {
    const root = tempDirs.make("openclaw-captured-history-");
    const execute = promisify(execFile);
    const git = async (...args: string[]) =>
      (
        await execute("git", [
          "-C",
          root,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ])
      ).stdout;
    await git("init", "-b", "main");
    await fs.writeFile(path.join(root, "file.txt"), "base\n");
    await git("add", "file.txt");
    await git("commit", "-m", "base");
    const base = (await git("rev-parse", "HEAD")).trim();
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "file.txt"), "captured\n");
    await git("commit", "-am", "captured change");
    const head = (await git("rev-parse", "HEAD")).trim();
    await fs.appendFile(path.join(root, "file.txt"), "later\n");
    await git("commit", "-am", "later change");
    const metadata = await loadSessionDiffBranchMetadata({
      root,
      base,
      head,
      gitOut: async (_root, args) => git(...args),
    });
    expect(metadata.aheadCount).toBe(1);
    expect(metadata.commits?.map((commit) => commit.subject)).toEqual(["captured change"]);
    expect(metadata.mergeBase?.subject).toBe("base");
  });
});
