import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { GIT_RELEASE_LAUNCHER, GIT_RELEASE_TRIAL, gitReleaseSlot } from "./git-release-paths.js";
import { createGitReleaseDirs, publishGitRelease } from "./git-release.js";
import { acquirePackageReleaseLease } from "./package-release-lease.js";
import { PACKAGE_RELEASES_DIR } from "./package-release-slot-path.js";
import type { CommandRunner } from "./update-runner-types.js";

const target = vi.hoisted(() => ({
  beforeRuntimeVerified: [] as boolean[],
  conversionTargets: [] as string[],
  runtimeVerified: false,
  runningRoot: "",
  /** The commit the update selects; defaults to the checkout's HEAD. */
  revision: undefined as string | undefined,
  /** Candidate builds the target selection started. */
  builds: 0,
  /** Release roots whose runtime artifacts do not verify. */
  broken: [] as string[],
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
  // The candidate (by default the checkout's HEAD) is built into the new release worktree;
  // like the real preflight, a verified serving release at that commit is current.
  selectGitInspectionTarget: async (params: {
    gitRoot: string;
    beforeSha: string;
    beforeRuntimeVerified: boolean;
    release: { prefix: string; worktreeDir: string };
    retainCleanup: (cleanup: () => Promise<boolean>) => boolean;
    beforeCandidate: (revision: string) => Promise<void>;
  }) => {
    target.beforeRuntimeVerified.push(params.beforeRuntimeVerified);
    const revision = target.revision ?? params.beforeSha;
    if (params.beforeRuntimeVerified && revision === params.beforeSha) {
      return { status: "skipped", reason: "already-current" };
    }
    // Admission runs before the candidate's worktree, install and build.
    await params.beforeCandidate(revision);
    target.builds += 1;
    await git(params.gitRoot, "worktree", "add", "--detach", params.release.worktreeDir, revision);
    // The caller removes a build it does not place, as with the real preflight.
    params.retainCleanup(async () => {
      await git(params.gitRoot, "worktree", "remove", "--force", params.release.worktreeDir);
      await fs.rm(params.release.prefix, { recursive: true, force: true });
      return true;
    });
    return { status: "ok", candidateSha: revision };
  },
}));
vi.mock("./update-git-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-git-runtime.js")>()),
  // The running release is at the requested commit but its runtime artifacts are incomplete.
  verifyGitUpdateRecovery: async (params: { root: string }) => {
    const root = await fs.realpath(params.root);
    return (target.runtimeVerified || root !== target.runningRoot) && !target.broken.includes(root)
      ? { serviceRestartSafe: true, version: "1.0.0", buildId: "serving" }
      : { serviceRestartSafe: false, reason: "runtime-verification-failed" };
  },
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
  target.revision = undefined;
  target.builds = 0;
  target.broken.length = 0;
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
    target.runningRoot = await fs.realpath(gitReleaseSlot(prefix));
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
      runCommand: (argv, options) =>
        argv[1]?.endsWith("openclaw.mjs")
          ? Promise.resolve({ code: 0, stdout: "1.0.0\n", stderr: "" })
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

    await convert(checkout);

    expect(target.conversionTargets).toEqual([serving]);
  });

  /**
   * The install an update leaves when it fails after the link switched but before any
   * Gateway started the new release: the link names release 2.0.0, which never served,
   * and `.trial` is armed with `attempts: 0` and falls back to 1.0.0, which serves.
   * With `pending`, a `--no-restart` update left 2.0.0 for the next service start instead.
   */
  async function halfSwitchedInstall(left: { pending?: boolean } = {}) {
    target.runtimeVerified = true;
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "git-release-left-")));
    roots.push(dir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
    const checkout = path.join(dir, "checkout");
    await fs.mkdir(checkout);
    await git(checkout, "init", "-q", "--initial-branch=main");
    await git(checkout, "config", "user.email", "test@example.com");
    await git(checkout, "config", "user.name", "Test");
    const commits: Record<string, string> = {};
    for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
      await fs.writeFile(
        path.join(checkout, "package.json"),
        JSON.stringify({ name: "openclaw", version }),
      );
      await git(checkout, "add", ".");
      await git(checkout, "commit", "-qm", version);
      commits[version] = await git(checkout, "rev-parse", "HEAD");
    }
    // The checkout stays at the commit first built; the update targets newer commits.
    await git(checkout, "checkout", "-q", "--detach", commits["1.0.0"]!);
    const prefix = path.join(dir, "state", "git-install");
    const slot = gitReleaseSlot(prefix);
    const place = async (version: string) => {
      const root = (await createGitReleaseDirs(prefix)).releaseRoot;
      await git(checkout, "worktree", "add", "-q", "--detach", root, commits[version]!);
      await fs.mkdir(path.join(root, "dist"));
      await fs.writeFile(path.join(root, "dist", "index.js"), `console.log("serving ${version}");`);
      return await fs.realpath(root);
    };
    const serving = await place("1.0.0");
    await publishGitRelease({ prefix, releaseRoot: serving, trial: false });
    const unserved = await place("2.0.0");
    await publishGitRelease({ prefix, releaseRoot: unserved, trial: true, ...left });
    const trialFile = path.join(prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL);
    const resolveLink = (link: string) => fs.realpath(path.resolve(path.dirname(slot), link));
    const releaseVersion = async (root: string) =>
      (
        JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
          version: string;
        }
      ).version;
    return {
      commits,
      slot,
      serving,
      unserved,
      trialFile,
      readTrial: async () => {
        const trial = JSON.parse(await fs.readFile(trialFile, "utf8")) as {
          target: string;
          previous: string;
        };
        return {
          target: await resolveLink(trial.target),
          previous: await resolveLink(trial.previous),
        };
      },
      releaseCount: async () =>
        (await fs.readdir(path.join(prefix, PACKAGE_RELEASES_DIR))).filter(
          (id) => !id.startsWith("."),
        ).length,
      update: (revision: string) => {
        target.revision = revision;
        return updateGitRelease({
          gitRoot: slot,
          // The service's Node prints the version of the release it loads.
          runCommand: async (argv, options) =>
            argv[1]?.endsWith("openclaw.mjs")
              ? { code: 0, stdout: `${await releaseVersion(path.dirname(argv[1]))}\n`, stderr: "" }
              : await runCommandWithTimeout(argv, options),
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
      },
      startGateway: () =>
        spawnSync(process.execPath, [path.join(prefix, GIT_RELEASE_LAUNCHER), "gateway"], {
          encoding: "utf8",
          timeout: 30_000,
        }),
    };
  }
  type HalfSwitchedInstall = Awaited<ReturnType<typeof halfSwitchedInstall>>;

  it("finishes activating a placed release that never served instead of reporting it current", async () => {
    const install = await halfSwitchedInstall();
    // The fallback was deselected days ago; age alone must not remove it.
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.resolve(install.serving, "../../.."), old, old);

    const result = await install.update(install.commits["2.0.0"]!);

    expect(result.status, JSON.stringify(result.steps)).toBe("ok");
    expect(result.before).toMatchObject({ sha: install.commits["1.0.0"], version: "1.0.0" });
    expect(result.after).toMatchObject({ sha: install.commits["2.0.0"], version: "2.0.0" });
    // The placed release is reused, not rebuilt, and its trial still falls back to 1.0.0.
    expect(target.builds).toBe(0);
    expect(await fs.realpath(install.slot)).toBe(install.unserved);
    expect(await install.releaseCount()).toBe(2);
    expect(await install.readTrial()).toEqual({
      target: install.unserved,
      previous: install.serving,
    });
    const note = result.steps.find((entry) => entry.name === "git-release-placement");
    expect(note?.advisory?.message).toBe(
      `Release ${path.basename(path.resolve(install.unserved, "../../.."))} was placed by an earlier update and has not passed its trial. Release ${path.basename(path.resolve(install.serving, "../../.."))} last passed a trial and stays the fallback. It is the target, so this update finishes activating it instead of rebuilding it.`,
    );
  });

  // The launcher runs under Node; Bun does not run it.
  it.skipIf(Boolean(process.versions.bun))(
    "falls back to the serving release and discards a superseded release that never served",
    async () => {
      const install = await halfSwitchedInstall();

      const result = await install.update(install.commits["3.0.0"]!);

      expect(result.status, JSON.stringify(result.steps)).toBe("ok");
      expect(result.before).toMatchObject({ sha: install.commits["1.0.0"], version: "1.0.0" });
      const candidate = await fs.realpath(install.slot);
      expect(await install.readTrial()).toEqual({ target: candidate, previous: install.serving });
      await expect(fs.access(install.unserved)).rejects.toThrow();
      expect(await install.releaseCount()).toBe(2);

      // The candidate fails both trial starts; the third start runs the release that served.
      await fs.mkdir(path.join(candidate, "dist"));
      await fs.writeFile(path.join(candidate, "dist", "index.js"), 'throw new Error("boot");');
      expect(install.startGateway().status).not.toBe(0);
      expect(install.startGateway().status).not.toBe(0);
      expect(install.startGateway().stdout).toContain("serving 1.0.0");
      expect(await fs.realpath(install.slot)).toBe(install.serving);
    },
  );

  it.each([
    [
      "started by the launcher",
      "1.0.0",
      async (install: HalfSwitchedInstall) => {
        const trial = JSON.parse(await fs.readFile(install.trialFile, "utf8")) as object;
        await fs.writeFile(install.trialFile, JSON.stringify({ ...trial, attempts: 1 }));
        return () => {};
      },
    ],
    [
      "leased by a running process",
      "2.0.0",
      async (install: HalfSwitchedInstall) => acquirePackageReleaseLease(install.unserved),
    ],
  ])("keeps a superseded release that was %s", async (_label, serving, mark) => {
    const install = await halfSwitchedInstall();
    const release = await mark(install);
    try {
      const result = await install.update(install.commits["3.0.0"]!);

      expect(result.status, JSON.stringify(result.steps)).toBe("ok");
      // A process running from it means it serves; a counted start alone does not.
      expect(result.before).toMatchObject({ version: serving });
      // It may have served, so its files stay; it never becomes the fallback either.
      await expect(fs.access(install.unserved)).resolves.toBeUndefined();
      expect(await install.readTrial()).toMatchObject({ previous: install.serving });
    } finally {
      release();
    }
  });

  it("discards a release a --no-restart update left for the next start once superseded", async () => {
    const install = await halfSwitchedInstall({ pending: true });

    const result = await install.update(install.commits["3.0.0"]!);

    expect(result.status, JSON.stringify(result.steps)).toBe("ok");
    expect(await install.readTrial()).toEqual({
      target: await fs.realpath(install.slot),
      previous: install.serving,
    });
    await expect(fs.access(install.unserved)).rejects.toThrow();
  });

  it("rebuilds the serving commit as the fallback when the trial's fallback does not verify", async () => {
    const install = await halfSwitchedInstall();
    target.broken.push(install.serving);

    const result = await install.update(install.commits["3.0.0"]!);

    expect(result.status, JSON.stringify(result.steps)).toBe("ok");
    // A back-out must land on a complete build of what serves, never on the placed release.
    expect(target.conversionTargets).toEqual([install.commits["1.0.0"]]);
    const { previous } = await install.readTrial();
    expect([install.serving, install.unserved]).not.toContain(previous);
    expect(
      JSON.parse(await fs.readFile(path.join(previous, "package.json"), "utf8")),
    ).toMatchObject({ version: "1.0.0" });
    await expect(fs.access(install.unserved)).rejects.toThrow();
  });

  it("changes nothing and refuses when no build of the serving commit exists", async () => {
    const install = await halfSwitchedInstall();
    const trial = await fs.readFile(install.trialFile, "utf8");
    await fs.rm(path.resolve(install.serving, "../../.."), { recursive: true });

    const result = await install.update(install.commits["3.0.0"]!);

    expect(result).toMatchObject({
      status: "error",
      reason: "git-release-fallback-unavailable",
      // Restarting would start the placed release with nothing to back out to.
      recovery: { serviceRestartSafe: false },
    });
    expect(target.builds).toBe(0);
    expect(await fs.realpath(install.slot)).toBe(install.unserved);
    expect(await fs.readFile(install.trialFile, "utf8")).toBe(trial);
    expect(result.steps.at(-1)?.stderrTail).toContain("openclaw triage");
  });

  it("puts the link back on the serving release when that release is the target", async () => {
    const install = await halfSwitchedInstall();

    const result = await install.update(install.commits["1.0.0"]!);

    expect(result).toMatchObject({ status: "skipped", reason: "already-current" });
    expect(await fs.realpath(install.slot)).toBe(install.serving);
    await expect(fs.access(install.trialFile)).rejects.toThrow();
    await expect(fs.access(install.unserved)).rejects.toThrow();
  });
});
