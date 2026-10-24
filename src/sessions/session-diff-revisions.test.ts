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
  "briefly reuses missing checkout results and observes a recreated checkout after expiry",
  async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
    await drainGlobalSingletonLifecycleState("restart");
    const parent = await fs.realpath(tempDirs.make("openclaw-missing-diff-"));
    const cwd = path.join(parent, "checkout");
    const timing: DiffReadTiming = { durations: {} };
    const stopDiagnostics = onTrustedInternalDiagnosticEvent(() => undefined, {
      includeTrusted: ["diagnostic.phase.completed"],
    });
    const read = () => {
      timing.durations = {};
      return loadCheckoutDiff({ cwd, sessionKey: "fixture" }, timing);
    };
    try {
      expect(await read()).toMatchObject({ files: [], unavailableReason: "not_git" });
      expect(timing.missReason).toBe("no-revision-missing");
      expect(await read()).toMatchObject({ files: [], unavailableReason: "not_git" });
      expect(timing.outcome).toBe("cache-hit");
      expect(timing.durations["worker-queue"]).toBe(0);
      await fs.mkdir(cwd);
      await promisify(execFile)("git", ["-C", cwd, "init", "-b", "main"]);
      await fs.writeFile(path.join(cwd, "created.txt"), "created\n");
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 1_001);
      const recreated = await read();
      expect(recreated.unavailableReason).toBeUndefined();
      expect(recreated.files).toEqual([
        expect.objectContaining({ path: "created.txt", additions: 1, status: "added" }),
      ]);
    } finally {
      stopDiagnostics();
      await drainGlobalSingletonLifecycleState("restart");
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "reuses diffs from nested and aliased linked worktrees while an index writer holds its lock",
  async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
    await drainGlobalSingletonLifecycleState("restart");
    const root = await fs.realpath(tempDirs.make("openclaw-linked-diff-"));
    const origin = path.join(root, "origin");
    const checkout = path.join(root, "checkout");
    const execute = promisify(execFile);
    const git = (...args: string[]) =>
      execute("git", [
        "-C",
        origin,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ]);
    const stopDiagnostics = onTrustedInternalDiagnosticEvent(() => undefined, {
      includeTrusted: ["diagnostic.phase.completed"],
    });
    try {
      await fs.mkdir(origin);
      await git("init", "-b", "main");
      await fs.writeFile(path.join(origin, "tracked.txt"), "before\n");
      await fs.writeFile(path.join(origin, ".gitignore"), "ignored/\n");
      await git("add", ".");
      await git("commit", "-m", "base");
      await git("worktree", "add", "--detach", checkout, "HEAD");
      await fs.mkdir(path.join(checkout, "nested"));
      await fs.mkdir(path.join(checkout, "ignored"));
      await fs.symlink(checkout, path.join(root, "alias"));
      await fs.appendFile(path.join(checkout, "tracked.txt"), "after\n");
      await fs.writeFile(path.join(origin, ".git/worktrees/checkout/index.lock"), "writer\n");
      for (const cwd of [path.join(checkout, "nested"), path.join(root, "alias")]) {
        const timing: DiffReadTiming = { durations: {} };
        const read = () => loadCheckoutDiff({ cwd, sessionKey: "fixture" }, timing);
        const first = await read();
        expect(first.files[0]?.patch).toContain("+after");
        await fs.writeFile(path.join(checkout, "ignored/build.txt"), "rebuilt\n");
        expect(await read()).toEqual(first);
        expect(timing.outcome).toBe("cache-hit");
        await fs.appendFile(path.join(checkout, "tracked.txt"), "later\n");
        expect((await read()).files[0]?.patch).toContain("+later");
        expect(timing.missReason).toBe("revision-changed-worktree-mtime");
      }
      const excludes = path.join(root, "ignore rules");
      await fs.appendFile(path.join(origin, ".git/config"), "\n# unrelated config\n".repeat(4096));
      await fs.writeFile(excludes, "external-ignore.txt\n");
      await fs.writeFile(path.join(checkout, "external-ignore.txt"), "untracked\n");
      await git("config", "core.excludesFile", "../ignore rules");
      const configuredTiming: DiffReadTiming = { durations: {} };
      const readConfigured = () =>
        loadCheckoutDiff({ cwd: checkout, sessionKey: "fixture" }, configuredTiming);
      const configured = await readConfigured();
      expect(configured.files.map((file) => file.path)).not.toContain("external-ignore.txt");
      expect(await readConfigured()).toEqual(configured);
      expect(configuredTiming.outcome).toBe("cache-hit");
      await fs.writeFile(excludes, "");
      expect((await readConfigured()).files.map((file) => file.path)).toContain(
        "external-ignore.txt",
      );
      await git("config", "filter.fixture.clean", "cat");
      const timing: DiffReadTiming = { durations: {} };
      expect(
        (await loadCheckoutDiff({ cwd: checkout, sessionKey: "fixture" }, timing)).files.find(
          (file) => file.path === "tracked.txt",
        )?.patch,
      ).toContain("+later");
      expect(timing.missReason).toBe("no-revision-config");
    } finally {
      stopDiagnostics();
      await drainGlobalSingletonLifecycleState("restart");
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "caches opaque nested repositories and refreshes gitlink dirtiness",
  async () => {
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
    await drainGlobalSingletonLifecycleState("restart");
    const root = await fs.realpath(tempDirs.make("openclaw-nested-repo-diff-"));
    const nested = path.join(root, "clone");
    const execute = promisify(execFile);
    const git = (cwd: string, ...args: string[]) =>
      execute("git", [
        "-C",
        cwd,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ]);
    const stopDiagnostics = onTrustedInternalDiagnosticEvent(() => undefined, {
      includeTrusted: ["diagnostic.phase.completed"],
    });
    try {
      await git(root, "init", "-b", "main");
      await git(root, "commit", "--allow-empty", "-m", "base");
      await fs.mkdir(nested);
      await git(nested, "init", "-b", "main");
      await fs.mkdir(path.join(nested, "content"));
      const nestedFile = path.join(nested, "content/file.txt");
      await fs.writeFile(nestedFile, "before\n");
      await git(nested, "add", ".");
      await git(nested, "commit", "-m", "nested base");
      for (const summaryOnly of [false, true]) {
        const timing: DiffReadTiming = { durations: {} };
        const read = () =>
          loadCheckoutDiff({ cwd: root, sessionKey: "fixture", summaryOnly }, timing);
        const opaque = await read();
        expect(opaque.files).toEqual([
          {
            path: "clone/",
            status: "added",
            additions: 0,
            deletions: 0,
            untracked: true,
            truncated: true,
          },
        ]);
        expect(await read()).toEqual(opaque);
        expect(timing.outcome).toBe("cache-hit");
        await fs.appendFile(nestedFile, "inside clone\n");
        expect(await read()).toEqual(opaque);
        expect(timing.outcome).toBe("cache-hit");
      }
      await git(nested, "commit", "-am", "nested changes");
      await git(root, "add", "clone");
      await git(root, "commit", "-m", "gitlink");
      const baseCommit = (await git(root, "rev-parse", "HEAD")).stdout.trim();
      const nestedBase = (await git(nested, "rev-parse", "HEAD")).stdout.trim();
      const timing: DiffReadTiming = { durations: {} };
      const read = () => loadCheckoutDiff({ cwd: root, sessionKey: "fixture" }, timing);
      expect((await read()).files).toEqual([]);
      await fs.appendFile(nestedFile, "dirty gitlink\n");
      const dirty = await read();
      expect(dirty.files).toEqual([
        { path: "clone", status: "modified", additions: 0, deletions: 0, truncated: true },
      ]);
      expect(await read()).toEqual(dirty);
      expect(timing.outcome).toBe("cache-hit");
      await git(nested, "commit", "-am", "new gitlink head");
      expect((await read()).files).toEqual([
        { path: "clone", status: "modified", additions: 1, deletions: 1, truncated: true },
      ]);
      await git(root, "add", "clone");
      await git(root, "commit", "-m", "updated gitlink");
      expect((await read()).files).toEqual([]);
      await fs.appendFile(nestedFile, "third commit\n");
      await git(nested, "commit", "-am", "third gitlink head");
      const nestedThird = (await git(nested, "rev-parse", "HEAD")).stdout.trim();
      await git(nested, "checkout", "--detach", nestedBase);
      const readFromBase = () =>
        loadCheckoutDiff({ cwd: root, sessionKey: "fixture", baseCommit }, timing);
      const atBase = await readFromBase();
      expect(atBase.files).toEqual([
        { path: "clone", status: "modified", additions: 0, deletions: 0, truncated: true },
      ]);
      expect(await readFromBase()).toEqual(atBase);
      expect(timing.outcome).toBe("cache-hit");
      await git(nested, "checkout", "--detach", nestedThird);
      expect((await readFromBase()).files).toEqual([
        { path: "clone", status: "modified", additions: 1, deletions: 1, truncated: true },
      ]);
    } finally {
      stopDiagnostics();
      await drainGlobalSingletonLifecycleState("restart");
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  },
);

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
