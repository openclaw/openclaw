import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { gitReleaseSlot } from "./git-release-paths.js";
import { createGitReleaseDirs, publishGitRelease } from "./git-release.js";
import type { CommandRunner } from "./update-runner-types.js";

const target = vi.hoisted(() => ({
  beforeRuntimeVerified: [] as boolean[],
  conversionTargets: [] as string[],
  runtimeVerified: false,
}));
vi.mock("./update-runner-git-preflight.js", () => ({
  // The first release is built from the commit that serves now.
  runGitCandidatePreflight: async (params: {
    gitRoot: string;
    targetRevision: string;
    release: { worktreeDir: string };
  }) => {
    target.conversionTargets.push(params.targetRevision);
    await git(
      params.gitRoot,
      "worktree",
      "add",
      "--detach",
      params.release.worktreeDir,
      params.targetRevision,
    );
    return { status: "ok", candidateSha: params.targetRevision };
  },
}));
vi.mock("./update-runner-git-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-runner-git-target.js")>()),
  fetchGitUpdateTarget: async () => ({ ok: true, refreshedRemotes: [] }),
  prepareGitMutation: async () => {},
  // The candidate is the commit already running, built into the new release worktree.
  selectGitInspectionTarget: async (params: {
    gitRoot: string;
    beforeSha: string;
    beforeRuntimeVerified: boolean;
    release: { worktreeDir: string };
  }) => {
    target.beforeRuntimeVerified.push(params.beforeRuntimeVerified);
    if (params.beforeRuntimeVerified) {
      return { status: "skipped", reason: "already-current" };
    }
    await git(params.gitRoot, "worktree", "add", "--detach", params.release.worktreeDir, "HEAD");
    return { status: "ok", candidateSha: params.beforeSha };
  },
}));
vi.mock("./update-git-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-git-runtime.js")>()),
  // The running release is at the requested commit but its runtime artifacts are incomplete.
  verifyGitUpdateRecovery: async () =>
    target.runtimeVerified
      ? { serviceRestartSafe: true, version: "1.0.0", buildId: "serving" }
      : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
}));

const { updateGitRelease } = await import("./update-runner-git-release.js");

async function git(root: string, ...args: string[]) {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], { timeoutMs: 10_000 });
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  target.beforeRuntimeVerified.length = 0;
  target.conversionTargets.length = 0;
  target.runtimeVerified = false;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("Git release updates", () => {
  it("rebuilds a same-commit release whose runtime artifacts do not verify", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "git-release-run-")));
    roots.push(dir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
    const checkout = path.join(dir, "checkout");
    await fs.mkdir(checkout);
    await git(checkout, "init", "-q", "--initial-branch=main");
    await git(checkout, "config", "user.email", "test@example.com");
    await git(checkout, "config", "user.name", "Test");
    await fs.writeFile(
      path.join(checkout, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0" }),
    );
    await git(checkout, "add", ".");
    await git(checkout, "commit", "-qm", "base");
    const prefix = path.join(dir, "state", "git-install");
    const running = (await createGitReleaseDirs(prefix)).releaseRoot;
    await git(checkout, "worktree", "add", "--detach", running, "HEAD");
    await publishGitRelease({ prefix, releaseRoot: running, trial: false });
    const runCommand: CommandRunner = (argv, options) =>
      argv[1]?.endsWith("openclaw.mjs")
        ? Promise.resolve({ code: 0, stdout: "1.0.0\n", stderr: "" })
        : runCommandWithTimeout(argv, options);

    const result = await updateGitRelease({
      gitRoot: gitReleaseSlot(prefix),
      runCommand,
      defaultCommandEnv: undefined,
      timeoutMs: 10_000,
      startedAt: Date.now(),
      opts: {
        channel: "dev",
        inspectGitTarget: async () => {},
        validateCandidate: async () => [],
        beforeGitMutation: async () => {},
        runGitDoctor: async () => null,
      },
    });

    expect(target.beforeRuntimeVerified).toEqual([false]);
    expect(result.status, JSON.stringify(result.steps)).toBe("ok");
    expect(await fs.realpath(gitReleaseSlot(prefix))).not.toBe(await fs.realpath(running));
  });

  it("builds the first release from the serving worktree's commit, not the checkout's HEAD", async () => {
    target.runtimeVerified = true;
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "git-release-conv-")));
    roots.push(dir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
    const checkout = path.join(dir, "checkout");
    await fs.mkdir(checkout);
    await git(checkout, "init", "-q", "--initial-branch=main");
    await git(checkout, "config", "user.email", "test@example.com");
    await git(checkout, "config", "user.name", "Test");
    const commit = async (version: string) => {
      await fs.writeFile(
        path.join(checkout, "package.json"),
        JSON.stringify({ name: "openclaw", version }),
      );
      await git(checkout, "commit", "-qam", version);
      return await git(checkout, "rev-parse", "HEAD");
    };
    await fs.writeFile(path.join(checkout, "package.json"), "{}");
    await git(checkout, "add", ".");
    const serving = await commit("1.0.0");
    const worktree = path.join(dir, "serving");
    await git(checkout, "worktree", "add", "-q", "--detach", worktree, serving);
    await commit("2.0.0");
    const runCommand: CommandRunner = (argv, options) =>
      argv[1]?.endsWith("openclaw.mjs")
        ? Promise.resolve({ code: 0, stdout: "1.0.0\n", stderr: "" })
        : runCommandWithTimeout(argv, options);

    await updateGitRelease({
      gitRoot: worktree,
      runCommand,
      defaultCommandEnv: undefined,
      timeoutMs: 10_000,
      startedAt: Date.now(),
      opts: {
        channel: "dev",
        inspectGitTarget: async () => {},
        validateCandidate: async () => [],
        beforeGitMutation: async () => {},
        runGitDoctor: async () => null,
      },
    });

    expect(target.conversionTargets).toEqual([serving]);
    // The healthy serving commit differs from the checkout, so the target is still built.
    expect(target.beforeRuntimeVerified).toEqual([false]);
  });
});
