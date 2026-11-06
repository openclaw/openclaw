import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { runCommandWithTimeout } from "../process/exec.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";

type RunCommand = typeof runCommandWithTimeout;
type GitResult = { code: number; stdout: string };

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let root: string;

beforeAll(() => {
  root = tempDirs.make("openclaw-dev-branch-");
});

function makeRunCommand(byArg: { toplevel?: GitResult; branch?: GitResult }): RunCommand {
  return async (argv: string[]) => {
    const key = argv.includes("--show-toplevel") ? "toplevel" : "branch";
    const res = byArg[key];
    if (!res) {
      throw new Error(`unexpected git invocation: ${argv.join(" ")}`);
    }
    return createCommandResult({ stdout: res.stdout, code: res.code });
  };
}

async function resolveBranch(
  packageRoot: string | null = root,
  branch: GitResult = { code: 0, stdout: "feat/dev-branch-badge\n" },
  toplevel: GitResult = { code: 0, stdout: `${root}\n` },
): Promise<string | null> {
  // mock-isolation: Resolve branches from synthetic Git responses without launching Git.
  vi.doMock("../process/exec.js", () => ({
    runCommandWithTimeout: makeRunCommand(
      packageRoot === null ? {} : { toplevel, ...(toplevel.code === 0 ? { branch } : {}) },
    ),
  }));
  // mock-isolation: The package-root cases must not inspect the real checkout layout.
  vi.doMock("./openclaw-root.js", () => ({
    resolveOpenClawPackageRoot: vi.fn(async () => packageRoot),
  }));
  const { resolveDevInstallGitBranch } = await import("./dev-install-branch.js");
  return await resolveDevInstallGitBranch();
}

// Runs the production resolver against real Git in a temp repo (only the
// package-root discovery is stubbed, so the exact production git invocations
// execute against real checkouts).
async function resolveBranchRealGit(packageRoot: string): Promise<string | null> {
  vi.doMock("./openclaw-root.js", () => ({
    resolveOpenClawPackageRoot: vi.fn(async () => packageRoot),
  }));
  const { resolveDevInstallGitBranch } = await import("./dev-install-branch.js");
  return await resolveDevInstallGitBranch();
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../process/exec.js");
  vi.doUnmock("./openclaw-root.js");
});

describe("resolveDevInstallGitBranch", () => {
  it("returns the branch for a source checkout on a feature branch", async () => {
    expect(await resolveBranch()).toBe("feat/dev-branch-badge");
  });

  it("returns null without a package root", async () => {
    expect(await resolveBranch(null)).toBeNull();
  });

  it("returns null when the root is not inside a git repo", async () => {
    expect(await resolveBranch(root, undefined, { code: 128, stdout: "" })).toBeNull();
  });

  it("returns null when the package root is nested inside an unrelated repo", async () => {
    const nested = path.join(root, "node_modules", "openclaw");
    await fs.mkdir(nested, { recursive: true });
    expect(await resolveBranch(nested, { code: 0, stdout: "some-branch\n" })).toBeNull();
  });

  it.each(["main", "master", "HEAD", ""])("hides mainline/detached state %j", async (name) => {
    expect(await resolveBranch(root, { code: 0, stdout: `${name}\n` })).toBeNull();
  });

  it("returns null when git branch resolution fails", async () => {
    expect(await resolveBranch(root, { code: 128, stdout: "" })).toBeNull();
  });
});

// Real-Git controls for the same-name-tag ambiguity: `rev-parse --abbrev-ref
// HEAD` prints identical output (`heads/main`) for a mainline checkout with a
// colliding tag and for a literal `heads/main` branch, which is why the
// resolver must read the actual branch identity instead of stripping prefixes.
describe("resolveDevInstallGitBranch with real git checkouts", () => {
  async function makeRepo(
    name: string,
  ): Promise<{ repo: string; git: (...args: string[]) => Promise<void> }> {
    const repo = path.join(root, "realgit", name);
    await fs.mkdir(repo, { recursive: true });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const git = async (...args: string[]) => {
      await execFileAsync("git", ["-C", repo, ...args]);
    };
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "Test User");
    await git("config", "user.email", "test@example.com");
    await git("commit", "-q", "--allow-empty", "-m", "init");
    return { repo, git };
  }

  it("hides a mainline checkout whose branch shares a name with a tag", async () => {
    const { repo, git } = await makeRepo("tagged-main");
    await git("tag", "main");
    expect(await resolveBranchRealGit(repo)).toBeNull();
  });

  it("keeps a literal heads/main branch visible without a colliding tag", async () => {
    const { repo, git } = await makeRepo("literal-heads-main");
    await git("branch", "heads/main");
    await git("checkout", "-q", "heads/main");
    // Identical `--abbrev-ref HEAD` output to the tagged-mainline case; only
    // the actual branch identity differs.
    expect(await resolveBranchRealGit(repo)).toBe("heads/main");
  });

  it("reports the real name of a feature branch that shares a name with a tag", async () => {
    const { repo, git } = await makeRepo("tagged-feature");
    await git("branch", "feat/dev-branch-badge");
    await git("checkout", "-q", "feat/dev-branch-badge");
    await git("tag", "feat/dev-branch-badge");
    expect(await resolveBranchRealGit(repo)).toBe("feat/dev-branch-badge");
  });

  it("hides a detached checkout", async () => {
    const { repo, git } = await makeRepo("detached");
    await git("checkout", "-q", "--detach", "HEAD");
    expect(await resolveBranchRealGit(repo)).toBeNull();
  });
});
