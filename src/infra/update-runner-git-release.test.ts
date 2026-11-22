import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectManagedGatewayServiceBeforeUpdate } from "../cli/update-cli/update-command-service-plan.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "../cli/update-cli/update-command-service-revalidation.js";
import type { GatewayServiceState } from "../daemon/service-types.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  GIT_RELEASE_LAUNCHER,
  GIT_RELEASE_TRIAL,
  gitReleaseSlot,
  gitReleaseForwardingEntry,
  prepareGitReleaseLayout,
} from "./git-release-paths.js";
import {
  collectGitReleases,
  createGitReleaseDirs,
  publishGitRelease,
  readGitReleasePlacement,
} from "./git-release.js";
import { readPackageVersion } from "./package-json.js";
import { acquirePackageReleaseLease } from "./package-release-lease.js";
import { PACKAGE_RELEASES_DIR, readPackageReleaseSlotSync } from "./package-release-slot-path.js";
import type { UpdateRunnerOptions } from "./update-runner-types.js";

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
  fetchFails: false,
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
    await fs.mkdir(path.join(params.release.worktreeDir, "dist"));
    await fs.writeFile(path.join(params.release.worktreeDir, "dist", "index.js"), "");
    return { status: "ok", candidateSha: params.targetRevision };
  },
}));
vi.mock("./update-runner-git-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-runner-git-target.js")>()),
  fetchGitUpdateTarget: async () =>
    target.fetchFails ? { ok: false, reason: "fetch-failed" } : { ok: true, refreshedRemotes: [] },
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

const writePackage = (checkout: string, version: string) =>
  fs.writeFile(path.join(checkout, "package.json"), JSON.stringify({ name: "openclaw", version }));
const writeBuildInfo = async (checkout: string, commit: string) => {
  await fs.mkdir(path.join(checkout, "dist"));
  await fs.writeFile(path.join(checkout, "dist", "build-info.json"), JSON.stringify({ commit }));
};

type Trial = { target: string; previous: string };
const roots: string[] = [];
const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
  target.fetchFails = false;
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
    await writePackage(checkout, "1.0.0");
    await git(checkout, "add", ".");
    await git(checkout, "commit", "-qm", "base");
    const prefix = path.join(dir, "state", "git-install");
    const running = (await createGitReleaseDirs(prefix)).releaseRoot;
    await git(checkout, "worktree", "add", "--detach", running, "HEAD");
    await publishGitRelease({ prefix, releaseRoot: running, trial: false });
    return { slot: gitReleaseSlot(prefix), running: await fs.realpath(running) };
  }

  const convert = (
    gitRoot: string,
    opts: Partial<UpdateRunnerOptions> = {},
    previousPackageRoot?: string,
  ) =>
    updateGitRelease({
      previousPackageRoot,
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
        ...opts,
      },
    });

  it("rebuilds a same-commit release whose runtime artifacts do not verify", async () => {
    const { slot, running } = await singleReleaseInstall();
    target.runningRoot = running;
    const beforeGitMutation = vi.fn(async () => {});

    const result = await convert(slot, { beforeGitMutation });

    expect(target.beforeRuntimeVerified).toEqual([false]);
    expect(result.status, JSON.stringify(result.steps)).toBe("ok");
    // The successful result carries the new release's verdict, not the incomplete one's.
    expect(result.recovery).toMatchObject({ serviceRestartSafe: true });
    expect(await fs.realpath(slot)).not.toBe(running);
    expect(beforeGitMutation).toHaveBeenCalledOnce();
  });

  it("reports a current release as prepared so finalization never regenerates it", async () => {
    target.runtimeVerified = true;
    const { slot } = await singleReleaseInstall();
    const beforeGitMutation = vi.fn(async () => {});

    const result = await convert(slot, { beforeGitMutation });

    expect(target.beforeRuntimeVerified).toEqual([true]);
    // Post-core finalization would otherwise run build scripts inside the release.
    expect(result).toMatchObject({ status: "skipped", sourceRuntimePrepared: true });
    // A release that equals the running one changes nothing, so nothing is copied.
    expect(beforeGitMutation).not.toHaveBeenCalled();
  });

  async function checkoutWithTwoCommits() {
    target.runtimeVerified = true;
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "git-release-conv-")));
    roots.push(dir);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
    const checkout = await initCheckout(dir);
    const commit = async (version: string) => {
      await writePackage(checkout, version);
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
    await writeBuildInfo(checkout, serving);
    await pulled();

    await convert(checkout);

    expect(target.conversionTargets).toEqual([serving]);
  });

  async function npmPackage(dir: string) {
    const root = path.join(dir, "npm", "lib", "node_modules", "openclaw");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "0.9.0", type: "module" }),
    );
    await fs.writeFile(path.join(root, "dist", "index.js"), 'console.log("npm gateway");');
    await fs.writeFile(path.join(root, "dist", "entry.js"), 'console.log("npm cli");');
    return root;
  }

  it.skipIf(Boolean(process.versions.bun)).each([false, true])(
    "restores the serving npm package after two failed Git switch starts (deferred: %s)",
    async (deferReleaseActivation) => {
      const { dir, checkout } = await checkoutWithTwoCommits();
      const previous = await npmPackage(dir);
      target.runtimeVerified = false;
      target.runningRoot = checkout;
      const result = await convert(checkout, { deferReleaseActivation }, previous);
      expect(result.status, `${result.reason}: ${JSON.stringify(result.steps)}`).toBe("ok");
      const prefix = path.join(dir, "state", "git-install");
      const slot = gitReleaseSlot(prefix);
      const launcher = path.join(prefix, GIT_RELEASE_LAUNCHER);
      const trialFile = path.join(prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL);
      const trial = JSON.parse(await fs.readFile(trialFile, "utf8")) as Trial;
      const candidate = path.resolve(prefix, trial.target);
      await fs.mkdir(path.join(candidate, "dist"), { recursive: true });
      await fs.writeFile(path.join(candidate, "dist", "index.js"), 'throw new Error("boot");');
      // The CLI exposure replaces only the npm bin entry; the original dist remains intact.
      const entry = path.join(previous, "openclaw.mjs");
      await fs.writeFile(entry, gitReleaseForwardingEntry(launcher));
      // An active collection may retire Git releases, never the external npm package.
      const stale = await createGitReleaseDirs(prefix);
      await fs.mkdir(stale.releaseRoot);
      await fs.utimes(stale.releasePrefix, threeDaysAgo, threeDaysAgo);
      await fs.utimes(previous, threeDaysAgo, threeDaysAgo);
      const collected = await collectGitReleases({
        prefix,
        keep: [],
        prune: async () => {},
        runningRoot: null,
      });
      if (!deferReleaseActivation) {
        expect(collected.removed).toContain(stale.releasePrefix);
      }
      const start = (args: string[]) =>
        spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 10_000 });
      expect(start(["gateway"]).status).not.toBe(0);
      expect(start(["gateway"]).status).not.toBe(0);
      const recovered = start(["gateway"]);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(recovered.stdout).toContain("npm gateway");
      expect(recovered.stderr).toContain("failed to start twice; switched back");
      expect(await fs.realpath(slot)).toBe(previous);
      expect(start(["--version"]).stdout).toContain("npm cli");
      expect(target.conversionTargets).toEqual([]);
      // A later update must not displace the working fallback link.
      expect(prepareGitReleaseLayout()).toBeUndefined();
      expect(await fs.realpath(slot)).toBe(previous);
      // Age and lack of a keep entry cannot make an external npm package collectible.
      await fs.utimes(previous, threeDaysAgo, threeDaysAgo);
      await fs.utimes(path.dirname(candidate), threeDaysAgo, threeDaysAgo);
      await collectGitReleases({ prefix, keep: [], prune: async () => {}, runningRoot: null });
      expect(await fs.readFile(path.join(previous, "dist", "index.js"), "utf8")).toContain(
        "npm gateway",
      );
    },
  );

  it("resumes an interrupted npm switch with the recorded package as fallback", async () => {
    const { dir, checkout } = await checkoutWithTwoCommits();
    const previous = await npmPackage(dir);
    const prefix = path.join(dir, "state", "git-install");
    await publishGitRelease({ prefix, releaseRoot: previous, trial: false });
    const candidate = (await createGitReleaseDirs(prefix)).releaseRoot;
    await git(checkout, "worktree", "add", "-q", "--detach", candidate, "HEAD");
    await fs.mkdir(path.join(candidate, "dist"));
    await fs.writeFile(path.join(candidate, "dist", "index.js"), "");
    await publishGitRelease({ prefix, releaseRoot: candidate, trial: true });
    const slot = gitReleaseSlot(prefix);
    const placement = await readGitReleasePlacement(readPackageReleaseSlotSync(slot)!, checkout);
    expect(placement).toEqual({
      serving: previous,
      fallback: previous,
      unserved: { root: candidate, selected: true },
    });

    const result = await convert(checkout);
    expect(result.status, `${result.reason}: ${JSON.stringify(result.steps)}`).toBe("ok");
    const trial = JSON.parse(
      await fs.readFile(path.join(prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL), "utf8"),
    ) as Trial;
    expect(await fs.realpath(path.resolve(prefix, trial.previous))).toBe(previous);
    expect(target.conversionTargets).toEqual([]);
  });

  /**
   * The install an update leaves when it fails after the link switched but before any
   * Gateway started the new release: the link names release 2.0.0, which never served,
   * and `.trial` is armed with `attempts: 0` and falls back to 1.0.0, which serves.
   * With `pending`, a `--no-restart` update left 2.0.0 for the next service start instead.
   * With `linkedCheckout`, the install checkout is a linked worktree of a repository built at 2.0.0.
   */
  async function halfSwitchedInstall(
    left: { pending?: boolean; linkedState?: boolean; linkedCheckout?: boolean } = {},
  ) {
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
      await writePackage(checkout, version);
      await git(checkout, "add", ".");
      await git(checkout, "commit", "-qm", version);
      commits[version] = await git(checkout, "rev-parse", "HEAD");
    }
    const install = left.linkedCheckout ? path.join(dir, "linked-checkout") : checkout;
    if (left.linkedCheckout) {
      await git(checkout, "worktree", "add", "-q", "--detach", install, commits["1.0.0"]!);
      await writeBuildInfo(checkout, commits["2.0.0"]!);
    }
    await git(install, "checkout", "-q", "--detach", commits["1.0.0"]!);
    await writeBuildInfo(install, commits["1.0.0"]!);
    const prefix = path.join(dir, "state", "git-install");
    const slot = gitReleaseSlot(prefix);
    const place = async (version: string) => {
      const root = (await createGitReleaseDirs(prefix)).releaseRoot;
      await git(install, "worktree", "add", "-q", "--detach", root, commits[version]!);
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
    return {
      commits,
      checkout: install,
      place,
      prefix,
      slot,
      serving,
      unserved,
      trialFile,
      readTrial: async () => {
        const t = JSON.parse(await fs.readFile(trialFile, "utf8")) as Trial;
        return { target: await resolveLink(t.target), previous: await resolveLink(t.previous) };
      },
      releaseCount: async () =>
        (await fs.readdir(path.join(prefix, PACKAGE_RELEASES_DIR))).filter(
          (id) => !id.startsWith("."),
        ).length,
      update: (revision: string, deferReleaseActivation?: boolean) => {
        target.revision = revision;
        return updateGitRelease({
          gitRoot: install,
          runCommand: async (argv, options) =>
            argv[1]?.endsWith("openclaw.mjs")
              ? {
                  code: 0,
                  stdout: `${await readPackageVersion(path.dirname(argv[1]))}\n`,
                  stderr: "",
                }
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
    ["", false, false],
    [", also when the launcher starts it during validation", true, false],
    // Its own build is the evidence, not the build of the repository it is a worktree of.
    [", with a linked-worktree checkout", false, true],
  ])("finishes activating a placed release that never served%s", async (_l, started, linked) => {
    const install = await halfSwitchedInstall({ linkedCheckout: linked });
    target.duringValidation = started ? install.countStart : undefined;
    // The fallback was deselected days ago; age alone must not remove it.
    await fs.utimes(path.dirname(install.serving), threeDaysAgo, threeDaysAgo);
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
    "falls back to the serving release and deselects a superseded release that never served",
    async () => {
      const install = await halfSwitchedInstall();
      const result = await install.update(install.commits["3.0.0"]!);
      expect(result.status, JSON.stringify(result.steps)).toBe("ok");
      expect(result.before).toMatchObject({ sha: install.commits["1.0.0"], version: "1.0.0" });
      const candidate = await fs.realpath(install.slot);
      expect(await install.readTrial()).toEqual({ target: candidate, previous: install.serving });
      expect(await install.releaseCount()).toBe(3);
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
      // The launcher owns a started trial's state rollback: the next trial falls back to it.
      expect((await install.readTrial()).previous).toBe(install.unserved);
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
  });

  it.each([
    [
      "local replay changes the target",
      (install: HalfSwitchedInstall) =>
        Object.assign(target, { replayed: install.commits["3.0.0"] }),
    ],
    [
      "the placed build does not verify",
      (install: HalfSwitchedInstall) => target.broken.push(install.unserved),
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
    ["deselects it once superseded", "3.0.0", 1],
  ])("a release a --no-restart update left: %s", async (_label, version, builds) => {
    const install = await halfSwitchedInstall({ pending: true });
    await install.update(install.commits[version]!);
    expect(target.builds).toBe(builds);
    const linked = await fs.realpath(install.slot);
    expect(await install.readTrial()).toEqual({ target: linked, previous: install.serving });
    expect(linked === install.unserved).toBe(builds === 0);
  });

  it.each([
    ["does not verify under a linked state directory", true],
    ["has a directory where the launcher's entry belongs", false],
  ])("rebuilds the serving commit as the fallback when it %s", async (label, linkedState) => {
    const install = await halfSwitchedInstall({ linkedState });
    if (label.startsWith("has a directory")) {
      await fs.rm(path.join(install.serving, "dist", "index.js"));
      await fs.mkdir(path.join(install.serving, "dist", "index.js"));
    } else {
      target.broken.push(install.serving);
    }
    await install.update(install.commits["3.0.0"]!);
    expect(target.conversionTargets).toEqual([install.commits["1.0.0"]]);
    const { previous } = await install.readTrial();
    expect([install.serving, install.unserved]).not.toContain(previous);
    expect(await readPackageVersion(previous)).toBe("1.0.0");
  });

  it.each([
    ["a newer target", "3.0.0"],
    ["the placed target", "2.0.0"],
    ["the serving target", "1.0.0"],
  ])("writes a link that resolves under a linked state directory for %s", async (_l, version) => {
    const install = await halfSwitchedInstall({ linkedState: true });
    const result = await install.update(install.commits[version]!);

    expect(result.status, JSON.stringify(result.steps)).not.toBe("error");
    expect(await git(install.slot, "rev-parse", "HEAD")).toBe(install.commits[version]);
  });

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
    ["is gone", "serving", [".."], ""],
    ["lost its Git metadata", "serving", [".git"], ""],
    // Only the checkout's build reporting its commit shows that the fallback serves.
    ["has no evidence that it serves", "checkout", ["dist"], ""],
    // After any Gateway's release lease, even from a failed boot, the checkout proves nothing.
    ["is incomplete and a Gateway took a release lease", "serving", [], "lease"],
    // An older publisher recorded never-started 2.0.0 as the fallback of a 3.0.0 trial, and
    // the repository the linked checkout belongs to is built at 2.0.0.
    ["never started and only its repository's build reports it", "serving", [], "linked"],
  ] as const)("changes nothing and refuses when the fallback %s", async (_l, root, gone, also) => {
    const install = await halfSwitchedInstall({ linkedCheckout: also === "linked" });
    if (also === "linked") {
      const releaseRoot = await install.place("3.0.0");
      await publishGitRelease({ prefix: install.prefix, releaseRoot, trial: true });
    }
    const trial = await fs.readFile(install.trialFile, "utf8");
    const link = await fs.realpath(install.slot);
    const release = path.dirname(install.serving);
    await Promise.all(gone.map((p) => fs.rm(path.resolve(install[root], p), { recursive: true })));
    if (also === "lease") {
      target.broken.push(install.serving);
      await fs.mkdir(path.join(release, "../.leases", path.basename(release)), { recursive: true });
    }

    const result = await install.update(install.commits["3.0.0"]!);

    const unsafe = { serviceRestartSafe: false };
    expect(result).toMatchObject({ status: "error", reason: "git-release-fallback-unavailable" });
    expect(result.recovery).toMatchObject(unsafe);
    expect(target.builds + target.conversionTargets.length).toBe(0);
    expect(await fs.realpath(install.slot)).toBe(link);
    expect(await fs.readFile(install.trialFile, "utf8")).toBe(trial);
    expect(result.steps.at(-1)?.stderrTail).toContain("openclaw triage");
    target.fetchFails = true; // A restart after an early failure would start the placed release.
    expect((await install.update(install.commits["3.0.0"]!)).recovery).toMatchObject(unsafe);
  });

  it.each([
    ["a newer target", "3.0.0"],
    ["the placed target", "2.0.0"],
  ])("leaves a half-switched install alone under --no-restart for %s", async (_l, version) => {
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
  });

  it("collects a deselected release only once it is old and not the updater's own", async () => {
    const install = await halfSwitchedInstall({ linkedState: true });
    await install.update(install.commits["1.0.0"]!);
    // Both through the symlinked state directory, as the updater sees them.
    const prefix = path.dirname(install.slot);
    const release = path.dirname(install.unserved);
    await fs.utimes(release, threeDaysAgo, threeDaysAgo);
    const own = path.join(prefix, "releases", path.basename(release), "openclaw");
    const collect = (runningRoot: string | null) =>
      collectGitReleases({ prefix, keep: [], prune: async () => {}, runningRoot });
    expect((await collect(own)).removed).toEqual([]);
    expect((await collect(null)).removed).toHaveLength(1);
    await expect(fs.access(install.unserved)).rejects.toThrow();
  });

  it("does not report the serving target current once the placed release ends its trial", async () => {
    const install = await halfSwitchedInstall();
    target.duringValidation = () => fs.rm(install.trialFile);
    const result = await install.update(install.commits["1.0.0"]!);
    expect(result).toMatchObject({ status: "error", reason: "git-release-selection-changed" });
    expect(result.recovery).toMatchObject({ serviceRestartSafe: false });
    expect(await fs.realpath(install.slot)).toBe(install.unserved);
  });

  it.each([false, true])(
    "converts a launcher-backed legacy slot without losing ownership (deferred: %s)",
    async (deferReleaseActivation) => {
      const { dir, checkout, serving } = await checkoutWithTwoCommits();
      vi.stubEnv("HOME", dir);
      mockSystemAccountHome();
      const prefix = path.join(dir, "state", "git-install");
      const legacy = path.join(prefix, "lib", "node_modules", "openclaw");
      const legacyRelease = path.join(
        prefix,
        "releases",
        "git-old",
        "lib",
        "node_modules",
        "openclaw",
      );
      await fs.mkdir(path.dirname(legacyRelease), { recursive: true });
      await git(checkout, "worktree", "add", "-q", "--detach", legacyRelease, serving);
      await fs.mkdir(path.join(legacyRelease, "dist"));
      await fs.writeFile(path.join(legacyRelease, "dist", "index.js"), "");
      await fs.mkdir(path.dirname(legacy), { recursive: true });
      await fs.symlink(path.relative(path.dirname(legacy), legacyRelease), legacy);
      const state: GatewayServiceState = {
        installed: true,
        running: false,
        loadState: { status: "loaded" },
        env: { HOME: dir },
        command: {
          programArguments: [process.execPath, path.join(prefix, GIT_RELEASE_LAUNCHER), "gateway"],
        },
        runtime: { status: "stopped", systemd: { managerUid: 1000 } },
      };
      const verdict = await inspectManagedGatewayServiceBeforeUpdate({ root: legacy, state });
      expect(verdict).toMatchObject({ kind: "owned", refreshDefinition: false });
      const revalidate = async () => {
        await revalidateManagedGatewayServiceAfterUpdate({
          root: legacy,
          state,
          preManagedServiceStop: {
            serviceEnv: state.env,
            serviceManagerUid: 1000,
            serviceUpdateVerdict: verdict,
          },
        });
      };
      target.runtimeVerified = false;
      // A newer commit at the same version: the fixture's `--version` answers 1.0.0.
      await fs.writeFile(path.join(checkout, "next.txt"), "next");
      await git(checkout, "add", ".");
      await git(checkout, "commit", "-qm", "next");
      target.revision = await git(checkout, "rev-parse", "HEAD");
      const result = await convert(legacy, {
        deferReleaseActivation,
        inspectGitTarget: revalidate,
        beforeGitMutation: revalidate,
      });

      expect(result.status, `${result.reason}: ${JSON.stringify(result.steps)}`).toBe("ok");
      expect(target.conversionTargets).toEqual([serving]);
      const served = await fs.realpath(gitReleaseSlot(prefix));
      expect(served.split(path.sep)).not.toContain("node_modules");
      if (!deferReleaseActivation) {
        // Old PATH entries keep working, but cannot select a release independently.
        expect(path.resolve(path.dirname(legacy), await fs.readlink(legacy))).toBe(
          gitReleaseSlot(prefix),
        );
        expect(await fs.realpath(legacy)).toBe(served);
        return;
      }
      // --no-restart leaves the running Gateway's build path alone; the next start selects the
      // pending release through the launcher and the new link.
      expect(await fs.realpath(legacy)).toBe(await fs.realpath(legacyRelease));
      const trial = JSON.parse(
        await fs.readFile(path.join(prefix, PACKAGE_RELEASES_DIR, GIT_RELEASE_TRIAL), "utf8"),
      ) as Trial & { pending: boolean };
      expect(trial.pending).toBe(true);
      const candidate = path.resolve(prefix, trial.target);
      expect(candidate).not.toBe(served);
      // The deferred start selects the target and the legacy link follows it.
      spawnSync(process.execPath, [path.join(prefix, GIT_RELEASE_LAUNCHER), "gateway"], {
        encoding: "utf8",
      });
      expect(await fs.realpath(gitReleaseSlot(prefix))).toBe(await fs.realpath(candidate));
      expect(await fs.realpath(legacy)).toBe(await fs.realpath(candidate));
    },
  );

  it("leaves the legacy slot selected when conversion fails before activation", async () => {
    const { dir, checkout, serving, pulled } = await checkoutWithTwoCommits();
    const prefix = path.join(dir, "state", "git-install");
    // Main builds since #199706 kept the link and its releases under lib/node_modules.
    const legacy = path.join(prefix, "lib", "node_modules", "openclaw");
    const legacyRelease = path.join(
      prefix,
      "releases",
      "git-old",
      "lib",
      "node_modules",
      "openclaw",
    );
    await fs.mkdir(path.dirname(legacyRelease), { recursive: true });
    await git(checkout, "worktree", "add", "-q", "--detach", legacyRelease, serving);
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.symlink(path.relative(path.dirname(legacy), legacyRelease), legacy);

    target.runtimeVerified = false;
    target.revision = await pulled();
    target.targetFails = true;
    const result = await convert(legacy);

    expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
    expect(await fs.realpath(legacy)).toBe(legacyRelease);
    await expect(fs.lstat(gitReleaseSlot(prefix))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
