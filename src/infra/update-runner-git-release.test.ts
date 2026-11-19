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

const target = vi.hoisted(() => ({
  beforeRuntimeVerified: [] as boolean[],
  conversionTargets: [] as string[],
  runtimeVerified: false,
  runningRoot: "",
  /** The commit the update selects; defaults to the checkout's HEAD. */
  revision: undefined as string | undefined,
  /** Candidate builds the target selection started. */
  builds: 0,
  /** Targets the update admitted through its inspection hook. */
  inspected: [] as (string | undefined)[],
  /** Release roots whose runtime artifacts do not verify. */
  broken: [] as string[],
  /** The commit local replay leaves checked out; defaults to the selected revision. */
  replayed: undefined as string | undefined,
  /** Runs while the candidate builds, as a concurrently starting service would. */
  duringBuild: undefined as (() => Promise<void>) | undefined,
  /** Roots the candidate validator checked. */
  validated: [] as string[],
  /** The target fails its candidate checks before the switch. */
  targetFails: false,
  /** Runs inside the candidate validator, as a service starting meanwhile would. */
  duringValidation: undefined as (() => Promise<void>) | undefined,
  /** The caller's mutation check refuses the update. */
  mutationRefused: false,
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
  prepareGitMutation: async (params: {
    revision: string;
    beforeGitMutation: (target: { sha?: string }) => Promise<void>;
  }) => params.beforeGitMutation({ sha: params.revision }),
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
    // Like the real preflight: admission, checkout and replay, admission again, then build.
    await params.beforeCandidate(revision);
    const checkedOut = target.replayed ?? revision;
    await git(
      params.gitRoot,
      "worktree",
      "add",
      "--detach",
      params.release.worktreeDir,
      checkedOut,
    );
    params.retainCleanup(async () => {
      await git(params.gitRoot, "worktree", "remove", "--force", params.release.worktreeDir);
      await fs.rm(params.release.prefix, { recursive: true, force: true });
      return true;
    });
    await params.beforeCandidate(checkedOut);
    target.builds += 1;
    await target.duringBuild?.();
    return target.targetFails
      ? { status: "error", reason: "preflight-no-good-commit" }
      : { status: "ok", candidateSha: checkedOut };
  },
}));
vi.mock("./update-git-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-git-runtime.js")>()),
  // The running release is at the requested commit but its runtime artifacts are incomplete.
  verifyGitUpdateRecovery: async (params: { root: string; sha: string | null }) => {
    const root = await fs.realpath(params.root);
    return params.sha &&
      (target.runtimeVerified || root !== target.runningRoot) &&
      !target.broken.includes(root)
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

async function initCheckout(dir: string) {
  const checkout = path.join(dir, "checkout");
  await fs.mkdir(checkout);
  await git(checkout, "init", "-q", "--initial-branch=main");
  await git(checkout, "config", "user.email", "test@example.com");
  await git(checkout, "config", "user.name", "Test");
  return checkout;
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
  target.inspected.length = 0;
  target.replayed = undefined;
  target.duringBuild = undefined;
  target.validated.length = 0;
  target.targetFails = false;
  target.duringValidation = undefined;
  target.mutationRefused = false;
  target.broken.length = 0;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("Git release updates", () => {
  /** One release at the checkout's only commit, selected by the link. */
  async function singleReleaseInstall() {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "git-release-run-")));
    roots.push(dir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
    const checkout = await initCheckout(dir);
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
    return { slot: gitReleaseSlot(prefix), running: await fs.realpath(running) };
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

  it("rebuilds a same-commit release whose runtime artifacts do not verify", async () => {
    const { slot, running } = await singleReleaseInstall();
    target.runningRoot = running;

    const result = await convert(slot);

    expect(target.beforeRuntimeVerified).toEqual([false]);
    expect(result.status, JSON.stringify(result.steps)).toBe("ok");
    // The successful result carries the new release's verdict, not the incomplete one's.
    expect(result.recovery).toMatchObject({ serviceRestartSafe: true });
    expect(await fs.realpath(slot)).not.toBe(running);
  });

  it("reports a current release as prepared so finalization never regenerates it", async () => {
    target.runtimeVerified = true;
    const { slot } = await singleReleaseInstall();

    const result = await convert(slot);

    expect(target.beforeRuntimeVerified).toEqual([true]);
    // Post-core finalization would otherwise run build scripts inside the release.
    expect(result).toMatchObject({ status: "skipped", sourceRuntimePrepared: true });
  });

  async function checkoutWithTwoCommits() {
    target.runtimeVerified = true;
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "git-release-conv-")));
    roots.push(dir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
    const checkout = await initCheckout(dir);
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
  async function halfSwitchedInstall(left: { pending?: boolean; linkedState?: boolean } = {}) {
    target.runtimeVerified = true;
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "git-release-left-")));
    roots.push(dir);
    if (left.linkedState) {
      // The state directory is a link to another depth, as macOS `/tmp` is `/private/tmp`.
      await fs.mkdir(path.join(dir, "x", "y", "real-state"), { recursive: true });
      await fs.symlink(path.join(dir, "x", "y", "real-state"), path.join(dir, "state"));
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
    const checkout = await initCheckout(dir);
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
    await git(checkout, "checkout", "-q", "--detach", commits["1.0.0"]!);
    await fs.mkdir(path.join(checkout, "dist"));
    await fs.writeFile(
      path.join(checkout, "dist", "build-info.json"),
      JSON.stringify({ commit: commits["1.0.0"] }),
    );
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
    await publishGitRelease({ prefix, releaseRoot: unserved, trial: true, pending: left.pending });
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
      checkout,
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
      update: (revision: string, deferReleaseActivation?: boolean) => {
        target.revision = revision;
        return updateGitRelease({
          gitRoot: slot,
          runCommand: async (argv, options) =>
            argv[1]?.endsWith("openclaw.mjs")
              ? { code: 0, stdout: `${await releaseVersion(path.dirname(argv[1]))}\n`, stderr: "" }
              : await runCommandWithTimeout(argv, options),
          defaultCommandEnv: undefined,
          timeoutMs: 10_000,
          startedAt: Date.now(),
          opts: {
            channel: "dev",
            inspectGitTarget: async (inspected) => {
              target.inspected.push(inspected.sha);
            },
            validateCandidate: async (root) => {
              target.validated.push(await fs.realpath(root));
              await target.duringValidation?.();
              return [];
            },
            beforeGitMutation: async () => {
              if (target.mutationRefused) {
                throw new Error("the caller refused the mutation");
              }
            },
            runGitDoctor: async () => null,
            deferReleaseActivation,
          },
        });
      },
      countStart: async () => {
        const trial = JSON.parse(await fs.readFile(trialFile, "utf8")) as object;
        await fs.writeFile(trialFile, JSON.stringify({ ...trial, attempts: 1 }));
      },
      startGateway: () =>
        spawnSync(process.execPath, [path.join(prefix, GIT_RELEASE_LAUNCHER), "gateway"], {
          encoding: "utf8",
          timeout: 30_000,
        }),
    };
  }
  type HalfSwitchedInstall = Awaited<ReturnType<typeof halfSwitchedInstall>>;

  it.each([
    ["", false],
    [", also when the launcher starts it during validation", true],
  ])("finishes activating a placed release that never served%s", async (_l, startedMeanwhile) => {
    const install = await halfSwitchedInstall();
    target.duringValidation = startedMeanwhile ? install.countStart : undefined;
    // The fallback was deselected days ago; age alone must not remove it.
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.resolve(install.serving, "../../.."), old, old);

    const result = await install.update(install.commits["2.0.0"]!);

    expect(result.status, JSON.stringify(result.steps)).toBe("ok");
    expect(result.before).toMatchObject({ sha: install.commits["1.0.0"], version: "1.0.0" });
    expect(result.after).toMatchObject({ sha: install.commits["2.0.0"], version: "2.0.0" });
    // Reused, not rebuilt; still admitted and checked; its trial still falls back to 1.0.0.
    expect(target.builds).toBe(0);
    expect(target.inspected).toContain(install.commits["2.0.0"]);
    expect(target.validated).toEqual([install.unserved]);
    expect(await fs.realpath(install.slot)).toBe(install.unserved);
    expect(await install.releaseCount()).toBe(2);
    expect(await install.readTrial()).toEqual({
      target: install.unserved,
      previous: install.serving,
    });
  });

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
      async (install: HalfSwitchedInstall) => {
        await install.countStart();
        return () => {};
      },
    ],
    [
      "leased by a running process",
      async (install: HalfSwitchedInstall) => acquirePackageReleaseLease(install.unserved),
    ],
  ])("leaves a trial whose release was %s to the launcher", async (_label, mark) => {
    const install = await halfSwitchedInstall();
    const release = await mark(install);
    try {
      const result = await install.update(install.commits["3.0.0"]!);

      // The launcher owns a started trial's state rollback; nothing here removes or re-arms it.
      await expect(fs.access(install.unserved)).resolves.toBeUndefined();
      expect(result.steps.some((entry) => entry.name === "git-release-placement")).toBe(false);
    } finally {
      release();
    }
  });

  it("keeps the link on a release that ended its trial while the target built", async () => {
    const install = await halfSwitchedInstall();
    target.duringBuild = () => fs.rm(install.trialFile);

    await install.update(install.commits["3.0.0"]!);

    expect(await install.readTrial()).toMatchObject({ previous: install.unserved });
    await expect(fs.access(install.unserved)).resolves.toBeUndefined();
  });

  it.each([
    [
      "local replay changes the target",
      async (install: HalfSwitchedInstall) => {
        target.replayed = install.commits["3.0.0"];
      },
    ],
    [
      "the placed build does not verify",
      async (install: HalfSwitchedInstall) => {
        target.broken.push(install.unserved);
      },
    ],
    [
      "Git cannot read the placed worktree's index",
      async (install: HalfSwitchedInstall) => {
        const gitDir = (await fs.readFile(path.join(install.unserved, ".git"), "utf8")).slice(8);
        await fs.writeFile(path.join(gitDir.trim(), "index"), "corrupt");
      },
    ],
    [
      "the placed worktree has tracked edits",
      (install: HalfSwitchedInstall) =>
        fs.appendFile(path.join(install.unserved, "package.json"), "\n"),
    ],
  ])("builds instead of reusing when %s", async (_label, arrange) => {
    const install = await halfSwitchedInstall();
    await arrange(install);

    await install.update(install.commits["2.0.0"]!);

    expect(target.builds).toBe(1);
    expect(await fs.realpath(install.slot)).not.toBe(install.unserved);
  });

  it.each([
    ["reuses it when it is the target", "2.0.0", 0],
    ["discards it once superseded", "3.0.0", 1],
  ])("a release a --no-restart update left: %s", async (_label, version, builds) => {
    const install = await halfSwitchedInstall({ pending: true });

    await install.update(install.commits[version]!);

    expect(target.builds).toBe(builds);
    const linked = await fs.realpath(install.slot);
    expect(await install.readTrial()).toEqual({ target: linked, previous: install.serving });
    expect(
      await fs.access(install.unserved).then(
        () => true,
        () => false,
      ),
    ).toBe(builds === 0);
  });

  it.each([
    ["", false],
    [" under a linked state directory", true],
  ])(
    "rebuilds the serving commit as the fallback when it does not verify%s",
    async (_l, linkedState) => {
      const install = await halfSwitchedInstall({ linkedState });
      target.broken.push(install.serving);

      await install.update(install.commits["3.0.0"]!);

      expect(target.conversionTargets).toEqual([install.commits["1.0.0"]]);
      const { previous } = await install.readTrial();
      expect([install.serving, install.unserved]).not.toContain(previous);
      expect(
        JSON.parse(await fs.readFile(path.join(previous, "package.json"), "utf8")),
      ).toMatchObject({ version: "1.0.0" });
      await expect(fs.access(install.unserved)).rejects.toThrow();
    },
  );

  it.each([
    ["a newer target", "3.0.0", (install: HalfSwitchedInstall) => fs.realpath(install.slot)],
    ["the placed target", "2.0.0", async (install: HalfSwitchedInstall) => install.unserved],
    ["the serving target", "1.0.0", async (install: HalfSwitchedInstall) => install.serving],
  ])(
    "writes a link that resolves under a linked state directory for %s",
    async (_label, version, intended) => {
      const install = await halfSwitchedInstall({ linkedState: true });

      const result = await install.update(install.commits[version]!);

      expect(result.status, JSON.stringify(result.steps)).not.toBe("error");
      expect(await fs.realpath(install.slot)).toBe(await intended(install));
    },
  );

  it("keeps the link and trial, and one rebuild, while the target keeps failing", async () => {
    const install = await halfSwitchedInstall();
    target.broken.push(install.serving);
    target.targetFails = true;
    const trial = await fs.readFile(install.trialFile, "utf8");

    const result = await install.update(install.commits["3.0.0"]!);
    await install.update(install.commits["3.0.0"]!);

    expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
    expect(target.conversionTargets).toEqual([install.commits["1.0.0"]]);
    expect(await install.releaseCount()).toBe(3);
    expect(await fs.realpath(install.slot)).toBe(install.unserved);
    expect(await fs.readFile(install.trialFile, "utf8")).toBe(trial);
  });

  it.each([
    ["is gone", (install: HalfSwitchedInstall) => path.resolve(install.serving, "../../..")],
    ["lost its Git metadata", (install: HalfSwitchedInstall) => path.join(install.serving, ".git")],
  ])("changes nothing and refuses when the fallback %s", async (_label, removed) => {
    const install = await halfSwitchedInstall();
    const trial = await fs.readFile(install.trialFile, "utf8");
    await fs.rm(removed(install), { recursive: true });

    const result = await install.update(install.commits["3.0.0"]!);

    expect(result).toMatchObject({
      status: "error",
      reason: "git-release-fallback-unavailable",
      recovery: { serviceRestartSafe: false },
    });
    expect(target.builds).toBe(0);
    expect(await fs.realpath(install.slot)).toBe(install.unserved);
    expect(await fs.readFile(install.trialFile, "utf8")).toBe(trial);
    expect(result.steps.at(-1)?.stderrTail).toContain("openclaw triage");
  });

  it.each([
    ["a newer target", "3.0.0"],
    ["the placed target", "2.0.0"],
  ])(
    "leaves the half-switched link and trial alone under --no-restart for %s",
    async (_l, version) => {
      const install = await halfSwitchedInstall();
      target.broken.push(install.serving);
      const trial = await fs.readFile(install.trialFile, "utf8");

      const result = await install.update(install.commits[version]!, true);

      expect(result.status, JSON.stringify(result.steps)).not.toBe("error");
      expect(target.conversionTargets).toEqual([]);
      expect(await fs.realpath(install.slot)).toBe(install.unserved);
      if (version === "2.0.0") {
        expect(await fs.readFile(install.trialFile, "utf8")).toBe(trial);
      }
    },
  );

  it("does not repair a trial whose fallback has no evidence that it served", async () => {
    const install = await halfSwitchedInstall();
    await fs.rm(path.join(install.checkout, "dist"), { recursive: true });

    const result = await install.update(install.commits["3.0.0"]!);

    expect(result.steps.some((entry) => entry.name === "git-release-placement")).toBe(false);
    await expect(fs.access(install.unserved)).resolves.toBeUndefined();
  });

  it("puts the link back on the serving release when that release is the target", async () => {
    const install = await halfSwitchedInstall();
    const trial = await fs.readFile(install.trialFile, "utf8");
    target.mutationRefused = true;
    await expect(install.update(install.commits["1.0.0"]!)).rejects.toThrow("refused");
    expect(await fs.realpath(install.slot)).toBe(install.unserved);
    expect(await fs.readFile(install.trialFile, "utf8")).toBe(trial);
    target.mutationRefused = false;
    target.validated.length = 0;

    const result = await install.update(install.commits["1.0.0"]!);

    expect(result).toMatchObject({ status: "skipped", reason: "already-current" });
    expect(target.validated).toEqual([install.serving]);
    expect(await fs.realpath(install.slot)).toBe(install.serving);
    await expect(fs.access(install.trialFile)).rejects.toThrow();
    await expect(fs.access(install.unserved)).rejects.toThrow();
  });
});
