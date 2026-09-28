import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  expectRuntime,
  runFixtureGit as git,
  expectCancelledGitCandidateCleanup,
  writeRuntime,
} from "./update-runner-git-candidate.test-support.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

describe("Git checkout execution", () => {
  const directories = useAutoCleanupTempDirTracker(afterEach);
  let directory: string;
  let root: string;
  let remote: string;
  let beforeSha: string;
  let events: string[];
  let stopped: boolean;
  let runCommand: CommandRunner;

  beforeEach(async () => {
    // Keep fixture-local identity authoritative during candidate rebases.
    vi.stubEnv("GIT_CONFIG_COUNT", "0");
    for (const key of [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ]) {
      vi.stubEnv(key, undefined);
    }
    directory = await fs.realpath(directories.make("openclaw-git-execution-"));
    root = path.join(directory, "checkout");
    remote = path.join(directory, "remote");
    await fs.mkdir(remote);
    await git(remote, "init", "--initial-branch=main");
    await git(remote, "config", "user.name", "OpenClaw Test");
    await git(remote, "config", "user.email", "openclaw@example.com");
    await fs.writeFile(
      path.join(remote, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.1", packageManager: "pnpm@12.0.0" }),
    );
    await fs.writeFile(path.join(remote, "openclaw.mjs"), "export {};\n");
    await fs.mkdir(path.join(remote, "packages", "runtime"), { recursive: true });
    await fs.writeFile(
      path.join(remote, "packages", "runtime", "index.js"),
      "module.exports = require('./node_modules/nested.cjs');",
    );
    await fs.writeFile(
      path.join(remote, ".gitignore"),
      "node_modules/\ndist/\ndist-runtime/\n.artifacts\n.pnpm\ncache/\n",
    );
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "base");
    beforeSha = await git(remote, "rev-parse", "HEAD");
    await git(directory, "clone", "--quiet", remote, root);
    await git(root, "config", "user.name", "OpenClaw Test");
    await git(root, "config", "user.email", "openclaw@example.com");
    await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), "node_modules/.pnpm");
    events = [];
    stopped = false;
    runCommand = async (argv, options) => {
      if (argv[0] === "git") {
        return runCommandWithTimeout(argv, options);
      }
      if (argv[0] === "pnpm") {
        if (argv[1] === "build") {
          expect(stopped).toBe(false);
          expect(options.cwd).not.toBe(root);
          await writeRuntime(
            options.cwd!,
            await git(options.cwd!, "rev-parse", "HEAD"),
            path.join(directory, "shared-store"),
            "node_modules/.pnpm",
          );
          events.push("build");
        }
        return { code: 0, stdout: argv[1] === "--version" ? "12.0.0" : "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${argv.join(" ")}`);
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function advanceRemote() {
    await fs.writeFile(path.join(remote, "candidate.txt"), "candidate\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "candidate");
    return git(remote, "rev-parse", "HEAD");
  }

  function update(opts: Partial<Omit<UpdateRunnerOptions, "prepareGitExposure">> = {}) {
    const { runGitDoctor, ...overrides } = opts;
    return updateGitCheckout({
      gitRoot: root,
      runCommand,
      defaultCommandEnv: undefined,
      timeoutMs: 5000,
      startedAt: Date.now(),
      opts: {
        channel: "dev",
        inspectGitTarget: async () => {},
        runGitDoctor:
          runGitDoctor ??
          (async (doctorRoot) => {
            expect(stopped).toBe(true);
            events.push("migrate");
            return {
              name: "openclaw doctor",
              command: "CLI activation doctor",
              cwd: doctorRoot,
              durationMs: 0,
              exitCode: 0,
            };
          }),
        validateCandidate: async (candidateRoot) => {
          expect(stopped).toBe(false);
          expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
          expect(candidateRoot).not.toBe(root);
          const candidateSha = await git(candidateRoot, "rev-parse", "HEAD");
          await expectRuntime(candidateRoot, candidateSha);
          events.push("validate");
        },
        beforeGitMutation: async () => {
          stopped = true;
          events.push("stop");
        },
        ...overrides,
      },
    });
  }

  it.each(["origin", "upstream.with.dots", "team/upstream"])(
    "updates from %s while an unrelated remote is unavailable",
    async (authority) => {
      const target = await advanceRemote();
      if (authority !== "origin") {
        await git(root, "remote", "rename", "origin", authority);
      }
      await git(root, "remote", "add", "secondary", path.join(directory, "unavailable"));
      const config = await fs.readFile(path.join(root, ".git", "config"));
      const result = await update();
      expect(result).toMatchObject({ status: "ok", after: { sha: target } });
      expect(result.steps.flatMap((step) => step.warnings ?? [])).toContain(
        `Fetched only the update remote ${authority}; unrelated remotes were left untouched.`,
      );
      expect(await fs.readFile(path.join(root, ".git", "config"))).toEqual(config);
      await expectRuntime(root, target);
    },
  );

  it("fails before activation when the authoritative remote is unavailable", async () => {
    await advanceRemote();
    await git(root, "remote", "add", "secondary", remote);
    await git(root, "remote", "set-url", "origin", path.join(directory, "unavailable"));
    const config = await fs.readFile(path.join(root, ".git", "config"));
    const result = await update();
    expect(result).toMatchObject({ status: "error", reason: "fetch-failed" });
    expect(stopped).toBe(false);
    expect(await fs.readFile(path.join(root, ".git", "config"))).toEqual(config);
    await expectRuntime(root, beforeSha);
  });

  it.each(["exit", "timeout", "timeout-zero", "output-limit-zero"] as const)(
    "ignores stale refs after optional fetch %s failure",
    async (failure) => {
      const target = await advanceRemote();
      await git(root, "remote", "add", "adead", path.join(directory, "unavailable"));
      await git(root, "update-ref", "refs/remotes/adead/main", beforeSha);
      await git(root, "checkout", "-b", "feature");
      await git(root, "branch", "-D", "main");
      const execute = runCommand;
      if (failure !== "exit") {
        runCommand = (argv, options) =>
          argv.includes("fetch") && argv.includes("adead")
            ? Promise.resolve({
                code: failure === "timeout" ? null : 0,
                stdout: "",
                stderr: "remote transport incomplete",
                ...(failure === "output-limit-zero"
                  ? { outputLimitExceeded: true }
                  : { killed: true, termination: "timeout" as const }),
              })
            : execute(argv, options);
      }
      const result = await update();
      expect(result).toMatchObject({ status: "ok", after: { sha: target } });
      expect(result.steps.find((step) => step.name.endsWith(":adead"))?.advisory).toMatchObject({
        kind: "recoverable-maintenance",
        message: expect.stringContaining("Could not refresh optional target remote adead"),
      });
      expect(await git(root, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
      await expectRuntime(root, target);
    },
  );

  it.each(["exit", "timeout", "signal", "timeout-zero", "output-limit-zero"] as const)(
    "settles optional tag discovery after %s",
    async (failure) => {
      const target = await advanceRemote();
      await git(remote, "tag", "requested", target);
      await git(root, "tag", "requested", beforeSha);
      await git(root, "remote", "add", "adead", path.join(directory, "unavailable"));
      const execute = runCommand;
      runCommand = (argv, options) =>
        failure !== "exit" && argv.includes("fetch") && argv.includes("adead")
          ? Promise.resolve({
              code: failure === "signal" ? 143 : failure === "timeout" ? null : 0,
              stdout: "",
              stderr: "tag transport interrupted",
              ...(failure === "output-limit-zero"
                ? { outputLimitExceeded: true }
                : {
                    killed: true,
                    termination: failure === "signal" ? ("signal" as const) : ("timeout" as const),
                  }),
            })
          : execute(argv, options);
      const result = await update({ devTarget: { mode: "detached", ref: "refs/tags/requested" } });
      expect(result.status).toBe(failure === "signal" ? "error" : "ok");
      expect(stopped).toBe(failure !== "signal");
      await expectRuntime(root, failure === "signal" ? beforeSha : target);
    },
  );

  it.each(["dirty", "unreadable"] as const)(
    "refuses a %s checkout before inspection or shutdown",
    async (kind) => {
      await advanceRemote();
      const commands: string[][] = [];
      const execute = runCommand;
      if (kind === "dirty") {
        await fs.writeFile(path.join(root, "operator.txt"), "keep me");
      }
      runCommand = (argv, options) => {
        commands.push(argv);
        if (kind === "unreadable" && argv[2] === root && argv[3] === "status") {
          return Promise.resolve({ code: 128, stdout: "", stderr: "index unavailable" });
        }
        return execute(argv, options);
      };
      const result = await update();
      expect(result).toMatchObject({
        status: "error",
        reason: kind === "dirty" ? "dirty" : "clean-check-failed",
      });
      expect(commands.some((argv) => argv.includes("clone") || argv.includes("fetch"))).toBe(false);
      expect(events).toEqual([]);
      expect(stopped).toBe(false);
      await expectRuntime(root, beforeSha);
    },
  );

  it.each(["install", "build"] as const)(
    "preserves the installed runtime when candidate %s fails",
    async (command) => {
      const target = await advanceRemote();
      await git(remote, "tag", "v2026.9.2", target);
      const execute = runCommand;
      runCommand = (argv, options) =>
        argv[0] === "pnpm" && argv[1] === command
          ? Promise.resolve({ code: 1, stdout: "", stderr: "candidate command failed" })
          : execute(argv, options);
      const result = await update({ channel: "stable" });
      expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
      expect(stopped).toBe(false);
      expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
      await expectRuntime(root, beforeSha);
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
    const execute = runCommand;
    runCommand = (argv, options) =>
      argv.includes("show") && argv.at(-1) === `${target}:package.json`
        ? Promise.resolve({ code: 0, stdout: "malformed manifest", stderr: "" })
        : execute(argv, options);

    await expect(update({ inspectGitTarget })).rejects.toBe(refusal);
    expect(inspectGitTarget).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    expect(stopped).toBe(false);
    expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    await expectRuntime(root, beforeSha);
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
      expect(stopped).toBe(false);
      expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
      await expectRuntime(root, beforeSha);
    },
  );

  it.each(["missing", "signal", "output-limit-zero", "output-limit-nonzero"] as const)(
    "classifies upstream setup failure without losing recovery: %s",
    async (failure) => {
      const interrupted = failure !== "missing";
      const target = await advanceRemote();
      await git(root, "checkout", "-b", "feature");
      await git(root, "branch", "-D", "main");
      const execute = runCommand;
      runCommand = (argv, options) =>
        argv[2] === root && argv.includes("--set-upstream-to")
          ? Promise.resolve({
              code: failure === "signal" ? 143 : failure === "output-limit-zero" ? 0 : 1,
              stdout: "",
              stderr: "upstream setup failed",
              ...(failure === "signal"
                ? { signal: "SIGTERM" as const, termination: "signal" as const }
                : {}),
              ...(failure.startsWith("output-limit-") ? { outputLimitExceeded: true } : {}),
            })
          : execute(argv, options);
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
      const execute = runCommand;
      let failed = false;
      runCommand = (argv, options) => {
        if (!failed && argv[0] === "pnpm" && argv[1] === "build") {
          failed = true;
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr: capacity
              ? "Error: ENOSPC: no space left on device, write"
              : "candidate build failed",
          });
        }
        return execute(argv, options);
      };
      const result = await update();
      expect(result.status).toBe(capacity ? "error" : "ok");
      expect(result.reason).toBe(capacity ? "preflight-insufficient-space" : undefined);
      expect(result.steps.filter((step) => step.name === "preflight-checkout")).toHaveLength(
        capacity ? 1 : 2,
      );
      expect(stopped).toBe(!capacity);
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
      expect(stopped).toBe(repair);
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
      const execute = runCommand;
      let stage: string | undefined;
      runCommand = async (argv, options) => {
        if (argv.includes("worktree") && argv.includes("remove")) {
          expect(options.timeoutMs).toBe(5000);
          return { code: 1, stdout: "", stderr: "synthetic worktree removal denied" };
        }
        return execute(argv, options);
      };
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
      const execute = runCommand;
      let stage: string | undefined;
      let buildCache: string | undefined;
      runCommand = (argv, options) => {
        if (argv[0] === "pnpm" && argv[1] === "build") {
          buildCache = options.env?.BUILD_ALL_CACHE_ROOT;
        }
        return execute(argv, options);
      };
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

  it.each([false, true])(
    "keeps a tracked target detached (initially detached: %s)",
    async (detached) => {
      const targetSha = await advanceRemote();
      await git(root, "remote", "rename", "origin", "upstream");
      await git(root, "remote", "add", "origin", path.join(directory, "unavailable"));
      if (detached) {
        await git(root, "checkout", "--detach", beforeSha);
      }
      const result = await update({
        devTarget: { mode: "tracked", upstreamRef: "upstream/main", upstreamSha: targetSha },
      });
      expect(result).toMatchObject({
        status: "ok",
        after: { sha: targetSha, upstreamRef: "upstream/main" },
      });
      expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      await expectRuntime(root, targetSha);
    },
  );

  it.each(["missing", "unrelated"])("refuses a tracked target with %s upstream", async (kind) => {
    const targetSha = await advanceRemote();
    if (kind === "unrelated") {
      await git(remote, "checkout", "-b", "unrelated", beforeSha);
      await fs.writeFile(path.join(remote, "unrelated.txt"), "unrelated");
      await git(remote, "add", ".");
      await git(remote, "commit", "-m", "unrelated target");
    }
    const result = await update({
      devTarget: { mode: "tracked", upstreamRef: "origin/" + kind, upstreamSha: targetSha },
    });
    expect(result).toMatchObject({ status: "error", reason: "tracked-upstream-invalid" });
    expect(stopped).toBe(false);
    expect(events).toEqual([]);
    expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    expect(await git(root, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
  });

  it.each(["doctor-error", "doctor-throw", "head-error", "head-mismatch", "ui-missing"] as const)(
    "retains the candidate after migration starts: %s",
    async (failure) => {
      const targetSha = await advanceRemote();
      const stateFile = path.join(directory, "operator-state");
      await fs.writeFile(stateFile, "old state");
      let migrated = false;
      const execute = runCommand;
      runCommand = (argv, options) => {
        if (migrated && argv[2] === root && argv[3] === "rev-parse" && argv[4] === "HEAD") {
          if (failure === "head-error") {
            return Promise.resolve({ code: 1, stdout: "", stderr: "HEAD unavailable" });
          }
          if (failure === "head-mismatch") {
            return Promise.resolve({ code: 0, stdout: beforeSha, stderr: "" });
          }
        }
        return execute(argv, options);
      };
      const result = await update({
        runGitDoctor: async (doctorRoot) => {
          expect(stopped).toBe(true);
          await expectRuntime(doctorRoot, targetSha);
          migrated = true;
          await fs.writeFile(stateFile, "migrated state");
          if (failure === "doctor-throw") {
            throw new Error("Doctor failed after migration");
          }
          if (failure === "ui-missing") {
            await fs.rm(path.join(root, "dist", "control-ui"), { recursive: true });
          }
          return {
            name: "openclaw doctor",
            command: "CLI activation doctor",
            cwd: doctorRoot,
            durationMs: 0,
            exitCode: failure === "doctor-error" ? 1 : 0,
          };
        },
      });
      expect(result).toMatchObject({
        status: "error",
        reason: {
          "doctor-error": "doctor-failed",
          "doctor-throw": "unexpected-error",
          "head-error": "head-verification-failed",
          "head-mismatch": "target-sha-mismatch",
          "ui-missing": "ui-assets-missing",
        }[failure],
        recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
      });
      expect(result.steps.some((step) => step.name.startsWith("git-rollback-"))).toBe(false);
      expect(await fs.readFile(stateFile, "utf8")).toBe("migrated state");
      expect(await git(root, "rev-parse", "HEAD")).toBe(targetSha);
      expect(
        JSON.parse(await fs.readFile(path.join(root, "dist", "build-info.json"), "utf8")),
      ).toMatchObject({ buildId: targetSha });
    },
  );

  it.each(["build", "locked worktree creation"] as const)(
    "settles cancelled candidate %s before returning",
    async (phase) => {
      const targetSha = await advanceRemote();
      await expectCancelledGitCandidateCleanup({
        phase,
        fixture: { localRoot: root, baseSha: beforeSha, targetSha },
        pnpmVersion: "12.0.0",
        runRealGit: git,
      });
      await expectRuntime(root, beforeSha);
    },
  );
});
