import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGit, type GitResult } from "../agents/worktrees/git.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveSessionDiffBase, resolveSessionDiffEmptyTree } from "./session-diff-revisions.js";

vi.mock("../agents/worktrees/git.js", () => ({ runGit: vi.fn() }));

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
  beforeEach(() => {
    vi.mocked(runGit).mockReset();
  });

  it("shares concurrent Git work per repository without retaining settled results", async () => {
    const first = createDeferredCore<GitResult>();
    const other = createDeferredCore<GitResult>();
    vi.mocked(runGit).mockImplementation((root) =>
      root === "first" ? first.promise : other.promise,
    );

    const pending = Array.from({ length: 32 }, () => resolveSessionDiffEmptyTree("first"));
    const otherPending = resolveSessionDiffEmptyTree("other");
    first.resolve(gitResult("first-tree\n"));
    other.resolve(gitResult("other-tree\n"));

    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 32 }, () => ({ base: "first-tree" })),
    );
    await expect(otherPending).resolves.toEqual({ base: "other-tree" });
    expect(runGit).toHaveBeenCalledTimes(2);

    vi.mocked(runGit).mockResolvedValue(gitResult("replacement-tree\n"));
    await expect(resolveSessionDiffEmptyTree("first")).resolves.toEqual({
      base: "replacement-tree",
    });
    expect(runGit).toHaveBeenCalledTimes(3);
  });

  it.each(["exit", "reject"])(
    "releases shared %s failures before a later request",
    async (failure) => {
      const command = createDeferredCore<GitResult>();
      vi.mocked(runGit).mockReturnValue(command.promise);
      const pending = Array.from({ length: 8 }, () => resolveSessionDiffEmptyTree("failed"));
      if (failure === "reject") {
        command.reject(new Error("Git unavailable"));
      } else {
        command.resolve(gitResult("", 128));
      }
      expect(await Promise.all(pending)).toEqual(Array.from({ length: 8 }, () => null));
      expect(runGit).toHaveBeenCalledOnce();

      vi.mocked(runGit).mockResolvedValue(gitResult("recovered-tree\n"));
      await expect(resolveSessionDiffEmptyTree("failed")).resolves.toEqual({
        base: "recovered-tree",
      });
      expect(runGit).toHaveBeenCalledTimes(2);
    },
  );
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
      const ref = args[0] === "rev-parse" ? args.at(-1) : args[1];
      const mergeBase = ref ? mergeBases.get(ref) : undefined;
      if (!mergeBase) {
        return null;
      }
      return args[0] === "merge-base" ? mergeBase : `${ref}-sha\n`;
    };

    await expect(
      resolveSessionDiffBase({ branch: "feature", gitOut, root: "/repo" }),
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

      await expect(resolveSessionDiffBase({ branch, gitOut, root: "/repo" })).resolves.toEqual({
        base: "HEAD",
        baseRef: "HEAD",
      });
    },
  );

  it("keeps HEAD when no default ref resolves", async () => {
    await expect(
      resolveSessionDiffBase({ branch: "feature", gitOut: async () => null, root: "/repo" }),
    ).resolves.toEqual({ base: "HEAD", baseRef: "HEAD" });
  });
});
