import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { hasErrnoCode } from "./errno.js";
import { runFixtureGit as git } from "./update-runner-git-candidate.test-support.js";
import { runGitCandidatePreflight } from "./update-runner-git-preflight.js";
import { withGitTargetInspectionRoot } from "./update-runner-git-target.js";
import type { CommandRunner, RunStepOptions } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

describe("reference source candidate preparation", () => {
  let root: string;
  let base: string;
  let installs: string[][];
  let builtInputs: Array<Record<string, string | null>>;
  let prepared:
    | { sha: string; parents: string[]; inputs: Record<string, string | null> }
    | undefined;
  let steps: UpdateStepResult[];
  let managerVersion: string;

  const readInputs = async (directory: string) => {
    const inputs: Record<string, string | null> = {};
    for (const file of [
      "local.txt",
      "feature.txt",
      "target.txt",
      "operator-input.txt",
      ".fixture-env",
    ]) {
      inputs[file] = await fs
        .readFile(path.join(directory, file), "utf8")
        .catch((error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return null;
          }
          throw error;
        });
    }
    return inputs;
  };

  async function commit(file: string, contents: string) {
    await fs.writeFile(path.join(root, file), contents);
    await git(root, "add", file);
    await git(root, "commit", "-m", file);
    return git(root, "rev-parse", "HEAD");
  }

  async function commitTarget(file: string, contents: string) {
    await git(root, "checkout", "-b", "upstream", base);
    const target = await commit(file, contents);
    await git(root, "checkout", "main");
    return target;
  }

  beforeEach(async () => {
    vi.stubEnv("GIT_CONFIG_COUNT", "0");
    for (const key of [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ]) {
      vi.stubEnv(key, undefined);
    }
    root = await fs.realpath(temporary.make("reference-source-preflight-"));
    await git(root, "init", "--initial-branch=main");
    await git(root, "config", "user.name", "OpenClaw Test");
    await git(root, "config", "user.email", "openclaw@example.com");
    await git(root, "config", "commit.gpgsign", "false");
    await fs.writeFile(
      path.join(root, ".gitignore"),
      "dist/\nnode_modules/\n.artifacts/\n.fixture-env\n",
    );
    await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.1", packageManager: "pnpm@12.0.0" }),
    );
    await git(root, "add", ".");
    await git(root, "commit", "-m", "base");
    base = await git(root, "rev-parse", "HEAD");
    installs = [];
    builtInputs = [];
    prepared = undefined;
    steps = [];
    managerVersion = "12.0.0";
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each(["candidate-uncertain", "cleanup-uncertain", "joined-failure"] as const)(
    "preserves private preparation only while child cleanup is uncertain: %s",
    async (phase) => {
      const joinedFailure = new Error("candidate command failed after joining");
      const uncertainFailure = new Error("candidate command cleanup failed", {
        cause: new CommandProcessCleanupError(),
      });
      let mirror: string | undefined;
      let worktree: string | undefined;
      let failureObserved = false;
      const commandsAfterFailure: string[][] = [];
      const removalsAfterFailure: string[] = [];
      const remove = fs.rm.bind(fs);
      const removal = vi.spyOn(fs, "rm").mockImplementation(async (entry, options) => {
        if (failureObserved) {
          removalsAfterFailure.push(String(entry));
        }
        return remove(entry, options);
      });
      const runCommand: CommandRunner = async (argv, options) => {
        if (failureObserved) {
          commandsAfterFailure.push(argv);
        }
        if (argv.includes("init") && argv.includes("--bare")) {
          mirror = argv.at(-1);
        }
        const result = await runCommandWithTimeout(argv, options);
        if (argv.includes("worktree") && argv.includes("add")) {
          expect(result.code, result.stderr).toBe(0);
          worktree = argv.at(-2);
          failureObserved = phase !== "cleanup-uncertain";
          throw phase === "candidate-uncertain" ? uncertainFailure : joinedFailure;
        }
        if (phase === "cleanup-uncertain" && argv.includes("worktree") && argv.includes("prune")) {
          expect(result.code, result.stderr).toBe(0);
          failureObserved = true;
          throw uncertainFailure;
        }
        return result;
      };
      try {
        const preparation = withGitTargetInspectionRoot(
          { root, runCommand, timeoutMs: 5000, onWarning: () => {} },
          async (gitRoot, runInspectionCommand) => {
            const step = (name: string, argv: string[], cwd: string): RunStepOptions => ({
              name,
              argv,
              cwd,
              runCommand: runInspectionCommand,
              timeoutMs: 5000,
              stepIndex: 0,
              totalSteps: 0,
            });
            return runGitCandidatePreflight({
              gitRoot,
              artifactRoot: root,
              refreshedRemotes: [],
              targetRevision: base,
              beforeSha: base,
              beforeRuntimeVerified: false,
              needsCheckoutMain: false,
              runCommand: runInspectionCommand,
              timeoutMs: 5000,
              defaultCommandEnv: undefined,
              steps: [],
              step,
              workStep: step,
              beforeCandidate: async () => {},
              validateCandidate: async () => {},
            });
          },
        );
        await expect(preparation).rejects.toBe(
          phase === "joined-failure" ? joinedFailure : uncertainFailure,
        );
        assert(mirror);
        assert(worktree);
        if (phase === "joined-failure") {
          expect(commandsAfterFailure.some((argv) => argv.includes("remove"))).toBe(true);
          expect(commandsAfterFailure.some((argv) => argv.includes("prune"))).toBe(true);
          await expect(fs.stat(path.dirname(worktree))).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.stat(path.dirname(mirror))).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(commandsAfterFailure).toEqual([]);
          expect(removalsAfterFailure).toEqual([]);
          expect((await fs.stat(path.dirname(worktree))).isDirectory()).toBe(true);
          expect((await fs.stat(mirror)).isDirectory()).toBe(true);
          if (phase === "candidate-uncertain") {
            expect((await fs.stat(worktree)).isDirectory()).toBe(true);
          }
        }
        expect(await git(root, "rev-parse", "HEAD")).toBe(base);
      } finally {
        removal.mockRestore();
        // The real fixture commands already joined before the synthetic cleanup error.
        if (worktree) {
          await remove(path.dirname(worktree), { recursive: true, force: true });
        }
        if (mirror) {
          await remove(path.dirname(mirror), { recursive: true, force: true });
        }
      }
    },
  );

  async function preflight(params: {
    branch: string;
    beforeSha: string;
    targetRevision: string;
    copyBuildInputs?: (candidate: string) => Promise<void>;
    validateCandidate?: (candidate: string) => Promise<void>;
  }) {
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(params.branch);
    const runCommand: CommandRunner = async (argv, options) => {
      if (argv[0] === "git") {
        return runCommandWithTimeout(argv, options);
      }
      if (["pnpm", "npm", "bun", "corepack"].includes(argv[0]!)) {
        if (argv.includes("install")) {
          installs.push(argv);
        }
        if (argv.includes("build")) {
          assert(options.cwd);
          expect(options.cwd).not.toBe(root);
          builtInputs.push(await readInputs(options.cwd));
          await fs.mkdir(path.join(options.cwd, "dist", "control-ui"), { recursive: true });
          await fs.writeFile(path.join(options.cwd, "dist", "control-ui", "index.html"), "ready");
        }
        return { code: 0, stdout: argv.includes("--version") ? managerVersion : "", stderr: "" };
      }
      throw new Error(`Unexpected candidate command: ${argv.join(" ")}`);
    };
    const step = (
      name: string,
      argv: string[],
      cwd: string,
      env?: NodeJS.ProcessEnv,
    ): RunStepOptions => ({
      name,
      argv,
      cwd,
      env,
      runCommand,
      timeoutMs: 5000,
      stepIndex: 0,
      totalSteps: 0,
      results: steps,
    });
    const options = {
      gitRoot: root,
      artifactRoot: root,
      refreshedRemotes: [],
      targetRevision: params.targetRevision,
      beforeSha: params.beforeSha,
      beforeRuntimeVerified: true,
      needsCheckoutMain: false,
      runCommand,
      timeoutMs: 5000,
      defaultCommandEnv: undefined,
      steps,
      step,
      workStep: step,
      beforeCandidate: async () => {},
      validateCandidate: params.validateCandidate ?? (async () => {}),
      referenceSource: {
        branch: params.branch,
        copyBuildInputs: params.copyBuildInputs ?? (async () => {}),
      },
      prepareCandidate: async (candidate: string) => {
        const head = await git(candidate, "rev-list", "--parents", "-n", "1", "HEAD");
        const [sha, ...parents] = head.split(" ");
        assert(sha);
        prepared = { sha, parents, inputs: await readInputs(candidate) };
      },
    };
    return runGitCandidatePreflight(options);
  }

  it("refuses divergent main before install or copying operator inputs", async () => {
    const beforeSha = await commit("local.txt", "local\n");
    await git(root, "checkout", "-b", "upstream", base);
    const targetRevision = await commit("target.txt", "target\n");
    await git(root, "checkout", "main");
    const copyBuildInputs = vi.fn(async () => {});

    expect(
      await preflight({ branch: "main", beforeSha, targetRevision, copyBuildInputs }),
    ).toMatchObject({ status: "error" });
    expect(installs).toEqual([]);
    expect(copyBuildInputs).not.toHaveBeenCalled();
    expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("local\n");
  });

  it.each(["server", "HEAD"])(
    "preserves merge commits and local content for %s",
    async (branch) => {
      await git(root, "checkout", "-b", "server");
      await commit("local.txt", "local\n");
      await git(root, "checkout", "-b", "feature", base);
      await commit("feature.txt", "feature\n");
      await git(root, "checkout", "server");
      await git(root, "merge", "--no-ff", "feature", "-m", "retain feature merge");
      const beforeSha = await git(root, "rev-parse", "HEAD");
      await git(root, "checkout", "main");
      const targetRevision = await commit("target.txt", "target\n");
      await git(root, "checkout", ...(branch === "HEAD" ? ["--detach", beforeSha] : [branch]));

      const result = await preflight({ branch, beforeSha, targetRevision });
      expect(result.status).toBe("ok");
      expect(prepared?.parents).toHaveLength(2);
      expect(prepared?.inputs).toMatchObject({
        "local.txt": "local\n",
        "feature.txt": "feature\n",
        "target.txt": "target\n",
      });
      expect(builtInputs).toEqual([prepared?.inputs]);
      expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
      expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    },
  );

  it.each([false, true])(
    "builds accepted untracked and ignored inputs (same HEAD: %s)",
    async (sameHead) => {
      const targetRevision = sameHead ? base : await commitTarget("target.txt", "target\n");
      const result = await preflight({
        branch: "main",
        beforeSha: base,
        targetRevision,
        copyBuildInputs: async (candidate) => {
          expect(await git(candidate, "rev-parse", "HEAD")).toBe(targetRevision);
          await fs.writeFile(path.join(candidate, "operator-input.txt"), "operator input\n");
          await fs.writeFile(path.join(candidate, ".fixture-env"), "ignored input\n");
        },
      });

      expect(result.status).toBe("ok");
      expect(builtInputs).toEqual([
        expect.objectContaining({
          "operator-input.txt": "operator input\n",
          ".fixture-env": "ignored input\n",
        }),
      ]);
      expect(installs).toEqual([["pnpm", "install", "--frozen-lockfile"]]);
      expect(await git(root, "rev-parse", "HEAD")).toBe(base);
    },
  );

  it.each(["working", "index", "committed"] as const)(
    "rejects %s source changes despite accepted untracked inputs",
    async (kind) => {
      const targetRevision = await commitTarget("target.txt", "target\n");
      const result = await preflight({
        branch: "main",
        beforeSha: base,
        targetRevision,
        copyBuildInputs: async (candidate) => {
          await fs.writeFile(path.join(candidate, "operator-input.txt"), "operator input\n");
        },
        validateCandidate: async (candidate) => {
          await fs.writeFile(path.join(candidate, "target.txt"), "unpublished change\n");
          if (kind !== "working") {
            await git(candidate, "add", "target.txt");
            if (kind === "index") {
              await fs.writeFile(path.join(candidate, "target.txt"), "target\n");
            } else {
              await git(candidate, "commit", "-m", "unpublished change");
            }
          }
        },
      });
      expect(result.status).toBe("error");
      expect(prepared).toBeUndefined();
      expect(steps).toContainEqual(
        expect.objectContaining({
          name:
            kind === "committed" ? "preflight-update-source-check" : "preflight-update-clean-check",
          exitCode: 1,
        }),
      );
      expect(await git(root, "rev-parse", "HEAD")).toBe(base);
    },
  );

  it.each(["bun@1.2.0", "pnpm@latest", "pnpm@12.1.0"])(
    "refuses unsupported candidate manager %s without provisioning",
    async (packageManager) => {
      const targetRevision = await commitTarget(
        "package.json",
        JSON.stringify({ name: "openclaw", version: "2026.9.1", packageManager }),
      );
      const result = await preflight({ branch: "main", beforeSha: base, targetRevision });
      expect(result).toMatchObject({ status: "error", reason: expect.stringContaining("pnpm") });
      expect(installs).toEqual([]);
      expect(builtInputs).toEqual([]);
    },
  );
});
