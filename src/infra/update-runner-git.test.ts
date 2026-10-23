import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { UpdateCommandOptions } from "../cli/update-cli/shared.js";
import { createUpdateCommandExecutionGuards } from "../cli/update-cli/update-command-execution-guards.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { createUpdateRunProgress } from "../cli/update-cli/update-command-run.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import * as tempRoot from "./tmp-openclaw-dir.js";
import { DoctorMaintenanceRefusalError } from "./update-doctor-result.js";
import { createUpdateRun } from "./update-run-ledger.js";
import {
  createGitUpdateFixture,
  expectRuntime,
  runFixtureGit as git,
  expectCancelledGitCandidateCleanup,
  type GitUpdateFixture,
} from "./update-runner-git-candidate.test-support.js";
import { selectChannelTag } from "./update-runner-git-target.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

const extendedOnly = ["v2026.9.33", "v2026.9.34", "v2026.9.34-1"];
it.each([
  ["stable", extendedOnly, null],
  ["beta", extendedOnly, null],
  ["beta", ["v2026.9.34", "v2026.9.33-beta.1", "v2026.9.32"], "v2026.9.33-beta.1"],
] as const)("selects %s release tag from %j as %s", (channel, tags, expected) => {
  expect(selectChannelTag(tags, channel)).toBe(expected);
});

const reply = (code = 0, stderr = "", stdout = "") => ({ code, stderr, stdout });
const doctorStep = (cwd: string, exitCode = 0) => ({
  name: "openclaw doctor",
  command: "CLI activation doctor",
  cwd,
  durationMs: 0,
  exitCode,
});

describe("Git checkout execution", () => {
  const directories = useAutoCleanupTempDirTracker(afterEach);
  let directory: string;
  let root: string;
  let remote: string;
  let beforeSha: string;
  let events: string[];
  let fixture: GitUpdateFixture;
  let runCommand: CommandRunner;

  beforeEach(async () => {
    directory = await fs.realpath(directories.make("openclaw-git-execution-"));
    fixture = await createGitUpdateFixture(directory);
    ({ root, remote, beforeSha, events, runCommand } = fixture);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const advanceRemote = () => fixture.advanceRemote();
  const head = () => git(root, "rev-parse", "HEAD");
  const config = () => fs.readFile(path.join(root, ".git", "config"));
  function intercept(
    handler: (
      ...args: Parameters<CommandRunner>
    ) => ReturnType<CommandRunner> | Awaited<ReturnType<CommandRunner>> | undefined,
  ) {
    const execute = runCommand;
    runCommand = (argv, options) =>
      Promise.resolve(handler(argv, options) ?? execute(argv, options));
  }
  async function expectInstalled(sha = beforeSha, savedConfig?: Buffer) {
    expect(await head()).toBe(sha);
    if (savedConfig) {
      expect(await config()).toEqual(savedConfig);
    }
    await expectRuntime(root, sha);
  }
  async function unrelatedBranch(contents = "unrelated branch content") {
    await git(remote, "checkout", "-b", "unrelated", beforeSha);
    await fs.writeFile(path.join(remote, "unrelated.txt"), contents);
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "unrelated remote work");
    return git(remote, "rev-parse", "HEAD:unrelated.txt");
  }

  function update(opts: Partial<Omit<UpdateRunnerOptions, "prepareGitExposure">> = {}) {
    const { runGitDoctor, ...overrides } = opts;
    fixture.runCommand = runCommand;
    return fixture.update({
      runGitDoctor:
        runGitDoctor ??
        (async (doctorRoot, steps = []) => {
          expect(fixture.stopped).toBe(true);
          events.push("migrate");
          const doctor = doctorStep(doctorRoot);
          steps.push(
            {
              ...doctor,
              name: "database migration writes",
              warnings: ["Automatic database restoration unavailable: unknown writer."],
            },
            doctor,
          );
          return doctor;
        }),
      ...overrides,
    });
  }

  it("updates from a namespaced remote while an unrelated remote is unavailable", async () => {
    const authority = "team/upstream";
    const target = await advanceRemote();
    await git(root, "remote", "rename", "origin", authority);
    await git(root, "remote", "add", "secondary", path.join(directory, "unavailable"));
    const savedConfig = await config();
    const result = await update();
    expect(result).toMatchObject({ status: "ok", after: { sha: target } });
    expect(result.steps.filter((step) => step.name === "openclaw doctor")).toHaveLength(1);
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: "database migration writes",
        warnings: ["Automatic database restoration unavailable: unknown writer."],
      }),
    );
    expect(result.steps.flatMap((step) => step.warnings ?? [])).toContain(
      `Fetched only the update remote ${authority}; unrelated remotes were left untouched.`,
    );
    await expectInstalled(target, savedConfig);
  });

  it.each(["untracked-main", "missing-main", "missing-origin"] as const)(
    "uses the same detached Dev source policy during execution (%s)",
    async (mode) => {
      const target = await advanceRemote();
      await git(root, "checkout", "--detach", beforeSha);
      if (mode === "untracked-main") {
        await git(root, "branch", "--unset-upstream", "main");
      } else {
        await git(root, "branch", "-D", "main");
      }
      if (mode === "missing-main") {
        await git(root, "update-ref", "-d", "refs/remotes/origin/main");
      }
      // A lexically earlier, healthy fork must never take over the Dev default.
      const other = path.join(directory, "other");
      await git(directory, "clone", "--quiet", remote, other);
      await git(other, "reset", "--hard", beforeSha);
      await git(root, "remote", "add", "aaa-fork", other);
      if (mode === "missing-origin") {
        await git(root, "remote", "remove", "origin");
        await git(root, "remote", "add", "another-fork", remote);
      }
      const savedConfig = await config();
      const result = await update();
      if (mode === "missing-origin") {
        expect(result.status).not.toBe("ok");
        expect(fixture.stopped).toBe(false);
        await expectInstalled(beforeSha, savedConfig);
      } else {
        expect(result).toMatchObject({ status: "ok", after: { sha: target } });
        await expectRuntime(root, target);
        if (mode === "missing-main") {
          expect(await git(root, "rev-parse", "main@{upstream}")).toBe(target);
        }
      }
    },
  );

  it.each([
    ["refs/heads/main", "refs/remotes/team/fork/main", "team/fork/main"],
    ["refs/heads/main", "refs/status/main", "refs/status/main"],
    ["main", "refs/status/main", "refs/status/main"],
    ["HEAD", "refs/status/main", "refs/status/main"],
    ["", "refs/status/main", "refs/status/main"],
    ["refs/heads/main", "remotes/team/fork/main", "refs/remotes/team/fork/main"],
    ["refs/heads/main", "heads/saved", "refs/heads/saved"],
    ["refs/heads/main", "tags/saved", "refs/tags/saved"],
    ["refs/heads/main", "saved", "refs/heads/saved"],
    ["refs/heads/*", "refs/remotes/team/fork/*", "refs/remotes/team/fork/release-$&"],
  ])(
    "keeps a pinned custom tracking target on its configured source (%s -> %s)",
    async (sourceRef, destination, trackingRef) => {
      const target = await advanceRemote();
      if (sourceRef.includes("*")) {
        await git(remote, "branch", trackingRef.slice(trackingRef.lastIndexOf("/") + 1), target);
      }
      await git(root, "remote", "rename", "origin", "team/fork");
      await git(root, "config", "remote.team/fork.fetch", "+" + sourceRef + ":" + destination);
      if (trackingRef !== "team/fork/main") {
        await git(root, "update-ref", "-d", "refs/remotes/team/fork/main");
        await git(root, "checkout", "--detach", beforeSha);
        await git(root, "branch", "-D", "main");
      }
      const other = path.join(directory, "other");
      if (trackingRef !== "team/fork/main") {
        await git(directory, "clone", "--quiet", remote, other);
        await git(other, "reset", "--hard", beforeSha);
      }
      await git(root, "remote", "add", "origin", other);
      const savedConfig = await config();
      const result = await update({
        devTarget: { mode: "tracked", upstreamRef: trackingRef, upstreamSha: target },
      });
      expect(result).toMatchObject({
        status: "ok",
        after: { sha: target, upstreamRef: trackingRef },
      });
      expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      await expectInstalled(target, savedConfig);
    },
  );

  it.each([false, true])(
    "fetches only the selected source before candidate admission (shallow: %s)",
    async (shallow) => {
      if (shallow) {
        await git(root, "fetch", "--depth=1", "origin");
      }
      const target = await advanceRemote();
      const unrelated = await unrelatedBranch();
      const savedConfig = await config();
      const resultRoots: string[] = [];
      intercept((argv) => {
        const inspection = argv.find((arg) => arg.startsWith("--git-dir="));
        if (inspection) {
          resultRoots.push(inspection.slice("--git-dir=".length));
        }
        return undefined;
      });
      const result = await update({
        inspectGitTarget: async () => {
          const inspection = resultRoots.at(-1)!;
          const object = await runCommandWithTimeout(
            ["git", "--no-lazy-fetch", "--git-dir=" + inspection, "cat-file", "-e", unrelated],
            { timeoutMs: 5000 },
          );
          expect(object.code).not.toBe(0);
        },
      });
      expect(result).toMatchObject({ status: "ok", after: { sha: target } });
      await expectInstalled(target, savedConfig);
    },
  );

  it("refuses an option-shaped upstream before downloading unrelated branches", async () => {
    await advanceRemote();
    const unrelated = await unrelatedBranch();
    await git(root, "config", "branch.main.merge", "--no-tags");
    const savedConfig = await config();
    const observations: { code: number | null; stdout: string }[] = [];
    const execute = runCommand;
    runCommand = async (argv, options) => {
      const result = await execute(argv, options);
      const inspection = argv.find((arg) => arg.startsWith("--git-dir="));
      if (inspection && argv.includes("fetch")) {
        const object = await runCommandWithTimeout(
          [
            "git",
            "--no-lazy-fetch",
            inspection,
            "cat-file",
            "--batch-check=%(objectname) %(objecttype)",
          ],
          { timeoutMs: 5000, input: unrelated + "\n" },
        );
        observations.push({ code: object.code, stdout: object.stdout.trim() });
      }
      return result;
    };
    const result = await update();
    expect(observations).toEqual([{ code: 0, stdout: unrelated + " missing" }]);
    expect(result).toMatchObject({ status: "error", reason: "fetch-failed" });
    expect(
      result.steps.find((step) => step.name === "git-target-inspection-fetch")?.stderrTail,
    ).toContain("--no-tags");
    expect(fixture.stopped).toBe(false);
    expect(events).toEqual([]);
    await expectInstalled(beforeSha, savedConfig);
  });

  it.each(["excluded", "unavailable"] as const)(
    "refuses an %s authoritative source before activation",
    async (source) => {
      await advanceRemote();
      if (source === "excluded") {
        await git(root, "config", "--add", "remote.origin.fetch", "^refs/heads/main");
      } else {
        await git(root, "remote", "add", "secondary", remote);
        await git(root, "remote", "set-url", "origin", path.join(directory, "unavailable"));
      }
      const savedConfig = await config();
      expect(await update()).toMatchObject({ status: "error", reason: "fetch-failed" });
      expect(fixture.stopped).toBe(false);
      expect(events).toEqual([]);
      await expectInstalled(beforeSha, savedConfig);
    },
  );

  it.each(["exit", "signal"] as const)(
    "settles optional tag discovery after %s",
    async (failure) => {
      const target = await advanceRemote();
      await git(remote, "tag", "requested", target);
      await git(root, "tag", "requested", beforeSha);
      await git(root, "remote", "add", "adead", path.join(directory, "unavailable"));
      intercept((argv) =>
        failure !== "exit" && argv.includes("fetch") && argv.includes("adead")
          ? Promise.resolve({
              code: failure === "signal" ? 143 : 0,
              stdout: "",
              stderr: "tag transport interrupted",
              killed: true,
              termination: "signal" as const,
            })
          : undefined,
      );
      const result = await update({ devTarget: { mode: "detached", ref: "refs/tags/requested" } });
      expect(result.status).toBe(failure === "signal" ? "error" : "ok");
      expect(fixture.stopped).toBe(failure !== "signal");
      await expectRuntime(root, failure === "signal" ? beforeSha : target);
    },
  );

  it.each(["dirty", "unreadable"] as const)(
    "refuses a %s checkout before inspection or shutdown",
    async (kind) => {
      await advanceRemote();
      const commands: string[][] = [];
      const stale = path.join(
        root,
        "dist.openclaw-update-00000000-0000-0000-0000-000000000000.tmp",
        "candidate",
      );
      if (kind === "dirty") {
        await fs.mkdir(path.dirname(stale));
        await fs.writeFile(stale, "operator-owned");
      }
      intercept((argv) => {
        commands.push(argv);
        if (kind === "unreadable" && argv[2] === root && argv[3] === "status") {
          return Promise.resolve(reply(128, "index unavailable"));
        }
        return undefined;
      });
      const result = await update();
      expect(result).toMatchObject({
        status: "error",
        reason: kind === "dirty" ? "dirty" : "clean-check-failed",
      });
      expect(commands.some((argv) => argv.includes("clone") || argv.includes("fetch"))).toBe(false);
      expect(events).toEqual([]);
      expect(fixture.stopped).toBe(false);
      await expectRuntime(root, beforeSha);
      if (kind === "dirty") {
        expect(await fs.readFile(stale, "utf8")).toBe("operator-owned");
      }
    },
  );

  it.each(["install", "build"] as const)(
    "preserves the installed runtime when candidate %s fails",
    async (command) => {
      const target = await advanceRemote();
      await git(remote, "tag", "v2026.9.2", target);
      const postbuild = path.join(root, "dist", ".runtime-postbuildstamp");
      if (command === "build") {
        await fs.rm(postbuild);
      }
      intercept((argv) =>
        argv[0] === "pnpm" && argv[1] === command
          ? Promise.resolve(reply(1, "candidate command failed"))
          : undefined,
      );
      const result = await update({ channel: "stable" });
      expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
      expect(fixture.stopped).toBe(false);
      await expectInstalled();
      if (command === "build") {
        await expect(fs.stat(postbuild)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("surfaces unreadable target metadata to admission before staging or mutation", async () => {
    const target = await advanceRemote();
    const refusal = new Error("Unreadable target metadata refused");
    const inspectGitTarget = vi.fn<UpdateRunnerOptions["inspectGitTarget"]>(async (candidate) => {
      expect(candidate).toEqual({
        sha: target,
        metadataUnreadable: expect.stringContaining("target package.json unparseable"),
      });
      throw refusal;
    });
    intercept((argv) =>
      argv.includes("show") && argv.at(-1) === `${target}:package.json`
        ? Promise.resolve(reply(0, "", "malformed manifest"))
        : undefined,
    );

    await expect(update({ inspectGitTarget })).rejects.toBe(refusal);
    expect(inspectGitTarget).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    expect(fixture.stopped).toBe(false);
    await expectInstalled();
  });

  it("does not invent a remote fallback for an existing main without an upstream", async () => {
    await advanceRemote();
    await git(root, "checkout", "-b", "feature");
    await git(root, "config", "--unset", "branch.main.remote");
    const result = await update();
    expect(result).toMatchObject({ status: "skipped", reason: "no-upstream" });
    expect(events).toEqual([]);
    expect(await git(root, "branch", "--show-current")).toBe("feature");
  });

  it.each(["checked-out", "rebase", "bisect"] as const)(
    "refuses a dev branch reserved by another worktree before stopping the installed gateway: %s",
    async (reservation) => {
      await advanceRemote();
      await git(root, "checkout", "--detach", beforeSha);
      const mainHolder = path.join(directory, "main-holder");
      await git(root, "worktree", "add", mainHolder, "main");
      if (reservation === "rebase") {
        await git(mainHolder, "commit", "--allow-empty", "-m", "holder commit");
        const tree = await git(root, "rev-parse", `${beforeSha}^{tree}`);
        const rebaseBase = await git(
          root,
          "commit-tree",
          tree,
          "-p",
          beforeSha,
          "-m",
          "rebase base",
        );
        await git(root, "update-ref", "refs/heads/rebase-base", rebaseBase);
        await expect(git(mainHolder, "rebase", "--exec", "false", "rebase-base")).rejects.toThrow();
      } else if (reservation === "bisect") {
        for (const subject of ["holder one", "holder two", "holder three"]) {
          await git(mainHolder, "commit", "--allow-empty", "-m", subject);
        }
        await git(mainHolder, "bisect", "start", "HEAD", beforeSha);
      }

      const result = await update();

      expect(result).toMatchObject({ status: "error", reason: "checkout-failed" });
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "git-activation-branch-check",
          stdoutTail: null,
          stderrTail: expect.stringContaining("a Git worktree uses or reserves branch main"),
        }),
      );
      expect(fixture.stopped).toBe(false);
      await expectInstalled();
    },
  );

  it.each(["missing", "signal", "output-limit-nonzero"] as const)(
    "classifies upstream setup failure without losing recovery: %s",
    async (failure) => {
      const interrupted = failure !== "missing";
      const target = await advanceRemote();
      await git(root, "checkout", "-b", "feature");
      await git(root, "branch", "-D", "main");
      intercept((argv) =>
        argv[2] === root && argv.includes("--set-upstream-to")
          ? Promise.resolve({
              code: failure === "signal" ? 143 : 1,
              stdout: "",
              stderr: "upstream setup failed",
              ...(failure === "signal"
                ? { signal: "SIGTERM" as const, termination: "signal" as const }
                : {}),
              ...(failure.startsWith("output-limit-") ? { outputLimitExceeded: true } : {}),
            })
          : undefined,
      );
      const result = await update();
      expect(result.status).toBe(interrupted ? "error" : "ok");
      const step = result.steps.find((candidate) => candidate.name === "git-set-upstream");
      if (interrupted) {
        expect(step?.advisory).toBeUndefined();
        expect(result).toMatchObject({
          reason: "checkout-failed",
          rollbackOutcome: { status: "succeeded" },
        });
        expect(await git(root, "branch", "--show-current")).toBe("feature");
      } else {
        expect(step?.advisory?.kind).toBe("recoverable-maintenance");
        expect(await git(root, "branch", "--show-current")).toBe("main");
      }
      await expectRuntime(root, interrupted ? beforeSha : target);
    },
  );

  it.each([true, false])(
    "walks back build failures but not confirmed storage exhaustion (capacity: %s)",
    async (capacity) => {
      const older = await advanceRemote();
      await fs.writeFile(path.join(remote, "latest.txt"), "latest");
      await git(remote, "add", ".");
      await git(remote, "commit", "-m", "latest");
      let failed = false;
      intercept((argv) => {
        if (!failed && argv[0] === "pnpm" && argv[1] === "build") {
          failed = true;
          return Promise.resolve(
            reply(
              1,
              capacity ? "Error: ENOSPC: no space left on device, write" : "candidate build failed",
            ),
          );
        }
        return undefined;
      });
      const result = await update();
      expect(result.status).toBe(capacity ? "error" : "ok");
      expect(result.reason).toBe(capacity ? "preflight-insufficient-space" : undefined);
      expect(result.steps.filter((step) => step.name === "preflight-checkout")).toHaveLength(
        capacity ? 1 : 2,
      );
      expect(fixture.stopped).toBe(!capacity);
      await expectRuntime(root, capacity ? beforeSha : older);
    },
  );

  it.each([false, true])(
    "repairs or rejects incomplete candidate UI before activation (repair: %s)",
    async (repair) => {
      const target = await advanceRemote();
      const execute = runCommand;
      runCommand = async (argv, options) => {
        const result = await execute(argv, options);
        if (argv[0] === "pnpm" && argv[1] === "build") {
          await fs.writeFile(
            path.join(options.cwd!, "dist", "control-ui", "index.html"),
            '<script src="./assets/missing.js"></script>',
          );
        }
        if (repair && argv[0] === "pnpm" && argv[1] === "ui:build") {
          await fs.mkdir(path.join(options.cwd!, "dist", "control-ui", "assets"), {
            recursive: true,
          });
          await fs.writeFile(
            path.join(options.cwd!, "dist", "control-ui", "assets", "missing.js"),
            "export {};\n",
          );
        }
        return result;
      };
      const result = await update({ devTarget: { mode: "detached", ref: target } });
      expect(result.status).toBe(repair ? "ok" : "error");
      expect(fixture.stopped).toBe(repair);
      expect(result.steps.some((step) => step.name === "preflight-ui-build")).toBe(true);
      if (!repair) {
        expect(result.steps).toContainEqual(
          expect.objectContaining({ name: "preflight-ui-assets-verify", exitCode: 1 }),
        );
      }
      await expectRuntime(root, repair ? target : beforeSha);
    },
  );

  it.each([false, true])(
    "settles worktree cleanup without hiding warnings (repair: %s)",
    async (repair) => {
      await advanceRemote();
      let stage: string | undefined;
      intercept((argv, options) => {
        if (argv.includes("worktree") && argv.includes("remove")) {
          expect(options.timeoutMs).toBe(5000);
          return reply(1, "synthetic worktree removal denied");
        }
        return undefined;
      });
      const remove = fs.rm.bind(fs);
      const deny = vi.spyOn(fs, "rm").mockImplementation((target, options) => {
        if (!repair && stage && String(target).startsWith(stage)) {
          return Promise.reject(new Error("synthetic cleanup denied"));
        }
        return remove(target, options);
      });
      try {
        const result = await update({
          validateCandidate: async (candidateRoot) => {
            stage = path.dirname(candidateRoot);
          },
        });
        expect(result.status).toBe("ok");
        const cleanup = result.steps.find((step) => step.name === "preflight-cleanup");
        expect(cleanup?.exitCode).toBe(repair ? 0 : 1);
        if (repair) {
          expect(cleanup?.stderrTail).toContain("fallback cleanup removed preflight tree");
        } else {
          expect(cleanup?.advisory).toMatchObject({
            kind: "recoverable-maintenance",
            message: expect.stringContaining("synthetic worktree removal denied"),
          });
        }
      } finally {
        deny.mockRestore();
        if (stage) {
          await remove(stage, { recursive: true, force: true });
        }
      }
    },
  );

  it.runIf(process.platform !== "win32").each([false, true])(
    "preserves artifact storage and build cache through inspected staging (redirected: %s)",
    async (redirected) => {
      const target = await advanceRemote();
      const artifacts = redirected
        ? path.join(directory, "external-artifacts")
        : path.join(root, ".artifacts");
      await fs.mkdir(artifacts);
      if (redirected) {
        await fs.symlink(artifacts, path.join(root, ".artifacts"), "dir");
      }
      await fs.writeFile(path.join(artifacts, "operator.txt"), "keep");
      await fs.chmod(artifacts, 0o750);
      const artifactStat = await fs.stat(artifacts);
      const rootMode = (await fs.stat(root)).mode;
      const parentMode = (await fs.stat(directory)).mode;
      let stage: string | undefined;
      let buildCache: string | undefined;
      intercept((argv, options) => {
        if (argv[0] === "pnpm" && argv[1] === "build") {
          buildCache = options.env?.BUILD_ALL_CACHE_ROOT;
        }
        return undefined;
      });
      try {
        await fs.chmod(directory, 0o555);
        const result = await update({
          validateCandidate: async (candidateRoot) => {
            stage = await fs.realpath(path.dirname(candidateRoot));
            expect(stage.startsWith(artifacts + path.sep)).toBe(true);
            const staged = await fs.stat(stage);
            expect(staged.mode & 0o777).toBe(0o700);
            expect(staged.dev).toBe(artifactStat.dev);
            expect(await git(root, "status", "--porcelain")).toBe("");
            expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
            await expectRuntime(candidateRoot, target);
          },
        });
        expect(result.status).toBe("ok");
        expect(stage).toBeDefined();
        await expect(fs.stat(stage!)).rejects.toMatchObject({ code: "ENOENT" });
        expect(buildCache).toBe(path.join(root, ".artifacts", "build-all-cache"));
        expect(await fs.readdir(artifacts)).toEqual(["operator.txt"]);
        expect((await fs.stat(artifacts)).mode).toBe(artifactStat.mode);
        expect((await fs.stat(root)).mode).toBe(rootMode);
        expect((await fs.stat(directory)).mode & 0o777).toBe(0o555);
        expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(stage);
        await expectRuntime(root, target);
      } finally {
        await fs.chmod(directory, parentMode & 0o777);
      }
    },
  );

  it.each(["missing", "unrelated"])("refuses a tracked target with %s upstream", async (kind) => {
    const targetSha = await advanceRemote();
    if (kind === "unrelated") {
      await unrelatedBranch("unrelated");
    }
    const result = await update({
      devTarget: { mode: "tracked", upstreamRef: "origin/" + kind, upstreamSha: targetSha },
    });
    expect(result).toMatchObject({ status: "error", reason: "tracked-upstream-invalid" });
    expect(fixture.stopped).toBe(false);
    expect(events).toEqual([]);
    expect(await head()).toBe(beforeSha);
    expect(await git(root, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
  });

  it.each([
    ["upstream", "origin", true, "stable", "tracked"],
    ["origin", "fork", false, "stable", "origin fallback"],
    ["upstream", undefined, false, "stable", "sole remote"],
    ["upstream", undefined, true, "beta", "extended tags"],
    ["upstream", undefined, true, "stable", "conflicting refspec"],
    ["upstream", "fork", false, "stable", "ambiguous"],
  ] as const)(
    "refreshes only release tags from %s with fork %s (tracked=%s, channel=%s, %s)",
    async (releaseRemote, forkRemote, tracked, channel, scenario) => {
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
      vi.stubEnv("LC_ALL", "C");
      await git(remote, "tag", "v2026.9.1");
      await git(root, "tag", "v2026.9.1");
      const release = await advanceRemote();
      await git(root, "fetch", "origin");
      await git(root, "checkout", "--detach", release);
      await fixture.writeRuntime(root, release);
      if (releaseRemote !== "origin") {
        await git(root, "remote", "rename", "origin", releaseRemote);
      }
      await git(root, "tag", "local-only", beforeSha);
      if (forkRemote) {
        const fork = path.join(directory, "fork.git");
        await git(directory, "clone", "--bare", remote, fork);
        await git(root, "remote", "add", forkRemote, fork);
      }
      // The corrected release is already installed; advancing main must not move it.
      await git(remote, "tag", "-f", "v2026.9.1", release);
      await git(remote, "commit", "--allow-empty", "-m", "next development commit");
      if (channel === "beta") {
        for (const tag of ["v2026.9.33", "v2026.9.34", "v2026.9.34-1"]) {
          await git(remote, "tag", tag, beforeSha);
        }
      }
      if (!tracked) {
        await git(root, "config", "--unset", "branch.main.remote");
      }
      if (scenario === "conflicting refspec") {
        await git(root, "branch", "protected", release);
        await git(root, "config", "remote.upstream.fetch", "refs/heads/main:refs/heads/protected");
        await git(remote, "reset", "--hard", beforeSha);
      }
      await git(root, "config", "fetch.prune", "true");
      await git(root, "config", "fetch.pruneTags", "true");
      const fetches: Array<{ code: number | null; refs: string[] }> = [];
      const execute = runCommand;
      runCommand = async (argv, options) => {
        if (argv[0] !== "git") {
          throw new Error(`Unexpected build command: ${argv[0]}`);
        }
        const result = await execute(argv, options);
        const fetchIndex = argv.indexOf("fetch");
        if (fetchIndex !== -1) {
          const refs = [];
          for (const ref of [
            "refs/tags/v2026.9.1",
            "refs/tags/local-only",
            `refs/remotes/${releaseRemote}/main`,
          ]) {
            const read = await execute([...argv.slice(0, fetchIndex), "rev-parse", ref], options);
            refs.push(read.code === 0 ? read.stdout.trim() : "");
          }
          fetches.push({ code: result.code, refs });
        }
        return result;
      };
      const forbidden = async () => {
        throw new Error("A refused fetch or current release must not enter candidate activation");
      };
      const result = await update({
        channel,
        inspectGitTarget: forbidden,
        validateCandidate: forbidden,
        beforeGitMutation: forbidden,
        runGitDoctor: forbidden,
      });
      if (scenario === "ambiguous") {
        expect(result).toMatchObject({ status: "error", reason: "fetch-failed" });
        expect(result.steps.at(-1)?.stderrTail).toContain("Set branch.main.remote");
        expect(fetches).toEqual([]);
      } else {
        expect(result).toMatchObject({ status: "skipped", reason: "already-current" });
        expect(fetches).toEqual([{ code: 0, refs: [release, beforeSha, release] }]);
      }
      if (scenario === "conflicting refspec") {
        expect(await git(root, "rev-parse", "protected")).toBe(release);
      }
      expect(await git(root, "rev-parse", "v2026.9.1", "local-only", "HEAD")).toBe(
        [beforeSha, beforeSha, release].join("\n"),
      );
    },
  );

  it.each([
    "doctor-failed",
    "doctor-threw",
    "doctor-data-at-risk",
    "head-error",
    "head-mismatch",
    "ui-missing",
  ] as const)("retains the candidate after migration starts: %s", async (failure) => {
    const targetSha = await advanceRemote();
    const stateFile = path.join(directory, "operator-state");
    await fs.writeFile(stateFile, "old state");
    let migrated = false;
    intercept((argv) => {
      if (migrated && argv[2] === root && argv[3] === "rev-parse" && argv[4] === "HEAD") {
        if (failure === "head-error") {
          return Promise.resolve(reply(1, "HEAD unavailable"));
        }
        if (failure === "head-mismatch") {
          return Promise.resolve(reply(0, "", beforeSha));
        }
      }
      return undefined;
    });
    const result = await update({
      runGitDoctor: async (doctorRoot) => {
        expect(fixture.stopped).toBe(true);
        await expectRuntime(doctorRoot, targetSha);
        migrated = true;
        await fs.writeFile(stateFile, "migrated state");
        if (failure === "doctor-threw") {
          throw new Error("Doctor failed after writing state");
        }
        if (failure === "doctor-data-at-risk") {
          throw new DoctorMaintenanceRefusalError("State is unreadable", {
            kind: "data-at-risk",
            reason: "unreadable-state",
          });
        }
        if (failure === "ui-missing") {
          await fs.rm(path.join(root, "dist", "control-ui"), { recursive: true });
        }
        return doctorStep(doctorRoot, failure === "doctor-failed" ? 1 : 0);
      },
    });
    expect(result).toMatchObject({
      status: "error",
      reason: {
        "doctor-failed": "doctor-failed",
        "doctor-threw": "unexpected-error",
        "doctor-data-at-risk": "unexpected-error",
        "head-error": "head-verification-failed",
        "head-mismatch": "target-sha-mismatch",
        "ui-missing": "ui-assets-missing",
      }[failure],
      recovery: {
        serviceRestartSafe: false,
        reason: "state-migration-started",
        dataAtRisk:
          failure === "doctor-data-at-risk" ? "unreadable-state" : "state-migrated-no-rollback",
      },
    });
    expect(result.steps.some((step) => step.name.startsWith("git-rollback-"))).toBe(false);
    expect(await fs.readFile(stateFile, "utf8")).toBe("migrated state");
    expect(await head()).toBe(targetSha);
    expect(
      JSON.parse(await fs.readFile(path.join(root, "dist", "build-info.json"), "utf8")),
    ).toMatchObject({ buildId: targetSha });
  });

  it.each(["build", "locked worktree creation"] as const)(
    "settles cancelled candidate %s before returning",
    async (phase) => {
      const targetSha = await advanceRemote();
      const env = { OPENCLAW_STATE_DIR: path.join(directory, "update-state") };
      const control = path.join(directory, "update-coordinator");
      await fs.mkdir(control);
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const run: NonNullable<UpdateCommandOptions["run"]> = {
        runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
        env,
      };
      const guards = createUpdateCommandExecutionGuards({ run }, root);
      try {
        await withUpdateCommandExecutor(run.runId, async (executor) => {
          guards.admitExecutor(await executor.enter(root));
          await expectCancelledGitCandidateCleanup({
            phase,
            fixture: { localRoot: root, baseSha: beforeSha, targetSha },
            pnpmVersion: "12.0.0",
            runRealGit: git,
            progress: createUpdateRunProgress(run, {}, guards.recordStep),
            onAbort: () => {
              run.interrupted = true;
            },
          });
        });
      } finally {
        await closeStateDatabaseForTest();
      }
      await expectRuntime(root, beforeSha);
    },
  );
});
