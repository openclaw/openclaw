import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runGit, type GitResult } from "../agents/worktrees/git.js";
import { onTrustedInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import type { DiffReadTiming } from "../infra/diff-read-timing.js";
import * as execRunner from "../process/exec-runner.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  loadSessionDiffBranchMetadata,
  resolveSessionDiffBase,
  resolveSessionDiffEmptyTree,
} from "./session-diff-revisions.js";
import { loadCheckoutDiff } from "./session-diff.js";

vi.mock("../agents/worktrees/git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/worktrees/git.js")>()),
  runGit: vi.fn(),
}));
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

  it.each([undefined, "--show-object-format", "unknown-format"])(
    "reads Git's empty tree for format %s without retaining failures",
    async (objectFormat) => {
      vi.mocked(runGit).mockResolvedValueOnce(gitResult("", 128));
      await expect(resolveSessionDiffEmptyTree("repo", objectFormat)).resolves.toBeNull();
      vi.mocked(runGit).mockResolvedValueOnce(gitResult("format-specific-empty-tree\n"));
      await expect(resolveSessionDiffEmptyTree("repo", objectFormat)).resolves.toEqual({
        base: "format-specific-empty-tree",
      });
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

it.skipIf(process.platform === "win32")(
  "reuses committed diffs across ignored and index churn but refreshes patch eligibility and attributes",
  async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
    await drainGlobalSingletonLifecycleState("restart");
    const root = await fs.realpath(tempDirs.make("openclaw-diff-cache-"));
    const execute = promisify(execFile);
    const git = (...args: string[]) =>
      execute("git", [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ]);
    const write = (file: string, content: string) => fs.writeFile(path.join(root, file), content);
    const timing: DiffReadTiming = { durations: {} };
    const read = () => loadCheckoutDiff({ cwd: root, sessionKey: "fixture" }, timing);
    const stopDiagnostics = onTrustedInternalDiagnosticEvent(() => undefined, {
      includeTrusted: ["diagnostic.phase.completed"],
    });
    try {
      await git("init", "-b", "main");
      await fs.mkdir(path.join(root, "nested"));
      await write("nested/tracked.txt", "before\n");
      await write(".gitignore", ".gitattributes\nignored.txt\n");
      await git("add", ".");
      await git("commit", "-m", "base");
      await git("checkout", "-b", "feature");
      await write("nested/tracked.txt", "before\nafter\n");
      await git("commit", "-am", "feature change");
      const linked = path.join(tempDirs.make("openclaw-diff-hardlink-"), "linked.txt");
      await fs.link(path.join(root, "nested/tracked.txt"), linked);
      const withheld = await read();
      expect(withheld.files[0]?.truncated).toBe(true);
      expect(withheld.files[0]?.patch).toBeUndefined();
      await read(); // Admit the clean committed file's displayed path.
      await fs.unlink(linked);
      const full = await read();
      expect(full.files[0]?.patch).toContain("+after");
      await read(); // Admit displayed paths' attribute dependencies.
      const commands = vi.spyOn(execRunner, "runCommandBuffersWithTimeout");
      expect(await read()).toEqual(full);
      expect(commands.mock.calls.length).toBe(0);
      await write("ignored.txt", "rebuilt output\n");
      await fs.utimes(path.join(root, ".git/index"), new Date(0), new Date(0));
      expect(await read()).toEqual(full);
      expect(commands.mock.calls.filter(([argv]) => !argv.includes("status")).length).toBe(0);
      await write("nested/tracked.txt", "before\nafter\nunstaged\n");
      await read();
      expect(timing.missReason).toBe("revision-changed-worktree-mtime");
      await write("nested/tracked.txt", "before\nafter\n");
      expect(await read()).toEqual(full);
      expect(timing.missReason).toBe("revision-changed-worktree-mtime");
      await write("nested/tracked.txt", "before\nafter\nstaged\n");
      await git("add", "nested/tracked.txt");
      await read();
      expect(timing.missReason).toBe("revision-changed-index");
      await write("nested/tracked.txt", "before\nafter\nstaged\nunstaged\n");
      await read();
      expect(timing.missReason).toBe("revision-changed-worktree-mtime");
      await write("nested/.gitattributes", "tracked.txt -diff\n");
      const changed = await read();
      expect(changed.files[0]?.binary).toBe(true);
      expect(changed.files[0]?.patch).toBeUndefined();
    } finally {
      stopDiagnostics();
      await drainGlobalSingletonLifecycleState("restart");
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  },
);
