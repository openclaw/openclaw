import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { gitReleaseSlot } from "./git-release-paths.js";
import { createGitReleaseDirs, publishGitRelease } from "./git-release.js";
import { readPackageVersion } from "./package-json.js";
import type { CommandRunner } from "./update-runner-types.js";

const target = vi.hoisted(() => ({
  beforeRuntimeVerified: [] as boolean[],
  conversionTargets: [] as string[],
  runtimeVerified: false,
  runningRoot: "",
}));
// mock-isolation: the build runs as a fixture; the real preflight would install and compile a checkout.
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
  verifyGitUpdateRecovery: async (params: { root: string }) =>
    target.runtimeVerified || params.root !== target.runningRoot
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
  target.runningRoot = "";
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
    target.runningRoot = gitReleaseSlot(prefix);
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
    // The successful result carries the new release's verdict, not the incomplete one's.
    expect(result.recovery).toMatchObject({ serviceRestartSafe: true });
    expect(await fs.realpath(gitReleaseSlot(prefix))).not.toBe(await fs.realpath(running));
  });

  it("reports a current release as prepared so finalization never regenerates it", async () => {
    target.runtimeVerified = true;
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "git-release-current-")));
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

    expect(target.beforeRuntimeVerified).toEqual([true]);
    // Post-core finalization would otherwise run build scripts inside the release.
    expect(result).toMatchObject({ status: "skipped", sourceRuntimePrepared: true });
  });

  async function checkoutWithTwoCommits() {
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
    return { dir, checkout, serving, pulled: () => commit("2.0.0") };
  }

  const convert = (gitRoot: string) =>
    updateGitRelease({
      gitRoot,
      runCommand: async (argv, options) =>
        argv[1]?.endsWith("openclaw.mjs")
          ? { code: 0, stdout: `${await readPackageVersion(path.dirname(argv[1]))}\n`, stderr: "" }
          : runCommandWithTimeout(argv, options),
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

  it("builds the first release from the serving worktree's commit, not the checkout's HEAD", async () => {
    const { dir, checkout, serving, pulled } = await checkoutWithTwoCommits();
    const worktree = path.join(dir, "serving");
    await git(checkout, "worktree", "add", "-q", "--detach", worktree, serving);
    await pulled();

    await convert(worktree);

    expect(target.conversionTargets).toEqual([serving]);
    // The healthy serving commit differs from the checkout, so the target is still built.
    expect(target.beforeRuntimeVerified).toEqual([false]);
  });

  it("builds the first release from the commit the checkout's dist was built from", async () => {
    const { checkout, serving, pulled } = await checkoutWithTwoCommits();
    // Built at 1.0.0, then pulled without rebuilding: the Gateway still serves 1.0.0.
    await fs.mkdir(path.join(checkout, "dist"));
    await fs.writeFile(
      path.join(checkout, "dist", "build-info.json"),
      JSON.stringify({ commit: serving }),
    );
    await pulled();

    const result = await convert(checkout);

    expect(target.conversionTargets).toEqual([serving]);
    expect(result.gitReleaseConversion).toMatchObject({
      slot: gitReleaseSlot(path.join(path.dirname(checkout), "state", "git-install")),
      selected: { target: await fs.readlink(result.root!) },
      previous: { release: { version: "1.0.0" } },
    });
  });
});
