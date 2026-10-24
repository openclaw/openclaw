import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { runCommandWithTimeout } from "../process/exec.js";

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
    return {
      stdout: res.stdout,
      stderr: "",
      code: res.code,
      signal: null,
      killed: false,
      termination: "exit" as const,
    };
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
