import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { hasErrnoCode } from "./errno.js";
import {
  runFixtureGit as git,
  isolateGitIdentity,
  writeGitFixtureManifest,
  writeFixtureFiles,
  expectHead,
  expectFile,
  expectMissing,
  expectStep,
  readText,
} from "./update-runner-git-candidate.test-support.js";
import { runGitCandidatePreflight } from "./update-runner-git-preflight.js";
import { withGitTargetInspectionRoot } from "./update-runner-git-target.js";
import type { CommandRunner } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

describe("reference source candidate preparation", () => {
  let root: string;
  let base: string;
  let installs: string[][];
  let builtInputs: Array<Record<string, string | null>>;
  let prepared: { parents: string[]; inputs: Record<string, string | null> } | undefined;
  let steps: UpdateStepResult[];

  const readInputs = async (directory: string) => {
    const inputs: Record<string, string | null> = {};
    for (const file of [
      "local.txt",
      "feature.txt",
      "target.txt",
      "operator-input.txt",
      ".fixture-env",
    ]) {
      inputs[file] = await readText(path.join(directory, file)).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      });
    }
    return inputs;
  };

  function prepare(
    runCommand: CommandRunner,
    options: Partial<Parameters<typeof runGitCandidatePreflight>[0]> = {},
  ) {
    const defaults = { runCommand, results: steps, timeoutMs: 5000, stepIndex: 0, totalSteps: 0 };
    const step = (name: string, argv: string[], cwd: string, env?: NodeJS.ProcessEnv) => ({
      ...defaults,
      name,
      argv,
      cwd,
      env,
    });
    return runGitCandidatePreflight({
      gitRoot: root,
      artifactRoot: root,
      refreshedRemotes: [],
      targetRevision: base,
      beforeSha: base,
      beforeRuntimeVerified: false,
      needsCheckoutMain: false,
      runCommand,
      timeoutMs: 5000,
      defaultCommandEnv: undefined,
      steps,
      step,
      workStep: step,
      beforeCandidate: async () => {},
      validateCandidate: async () => {},
      ...options,
    });
  }

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
    isolateGitIdentity();
    root = await fs.realpath(temporary.make("reference-source-preflight-"));
    await git(root, "init", "--initial-branch=main");
    await git(root, "config", "user.name", "OpenClaw Test");
    await git(root, "config", "user.email", "openclaw@example.com");
    await git(root, "config", "commit.gpgsign", "false");
    await writeFixtureFiles(root, {
      ".gitignore": "dist/\nnode_modules/\n.artifacts/\n.fixture-env\n",
      "pnpm-workspace.yaml": "packages: []\n",
    });
    await writeGitFixtureManifest(root);
    await git(root, "add", ".");
    await git(root, "commit", "-m", "base");
    base = await git(root, "rev-parse", "HEAD");
    installs = [];
    builtInputs = [];
    prepared = undefined;
    steps = [];
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
          (gitRoot, runInspectionCommand) => prepare(runInspectionCommand, { gitRoot }),
        );
        await expect(preparation).rejects.toBe(
          phase === "joined-failure" ? joinedFailure : uncertainFailure,
        );
        assert(mirror);
        assert(worktree);
        if (phase === "joined-failure") {
          expect(commandsAfterFailure.some((argv) => argv.includes("remove"))).toBe(true);
          expect(commandsAfterFailure.some((argv) => argv.includes("prune"))).toBe(true);
          await expectMissing(path.dirname(worktree));
          await expectMissing(path.dirname(mirror));
        } else {
          expect(commandsAfterFailure).toEqual([]);
          expect(removalsAfterFailure).toEqual([]);
          expect((await fs.stat(path.dirname(worktree))).isDirectory()).toBe(true);
          expect((await fs.stat(mirror)).isDirectory()).toBe(true);
          if (phase === "candidate-uncertain") {
            expect((await fs.stat(worktree)).isDirectory()).toBe(true);
          }
        }
        await expectHead(root, base);
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
        return { code: 0, stdout: argv.includes("--version") ? "12.0.0" : "", stderr: "" };
      }
      throw new Error(`Unexpected candidate command: ${argv.join(" ")}`);
    };
    return prepare(runCommand, {
      targetRevision: params.targetRevision,
      beforeSha: params.beforeSha,
      beforeRuntimeVerified: true,
      validateCandidate: params.validateCandidate ?? (async () => {}),
      referenceSource: {
        branch: params.branch,
        copyBuildInputs: params.copyBuildInputs ?? (async () => {}),
      },
      prepareCandidate: async (candidate: string) => {
        const head = await git(candidate, "rev-list", "--parents", "-n", "1", "HEAD");
        const [, ...parents] = head.split(" ");
        prepared = { parents, inputs: await readInputs(candidate) };
      },
    });
  }

  it.each([false, true])(
    "refreshes final dependency links after exposure (corrupt: %s)",
    async (corrupt) => {
      const linker = pathToFileURL(
        path.resolve("scripts/lib/bundled-plugin-dependency-links.mjs"),
      ).href;
      const script = "scripts/copy-bundled-plugin-metadata.mjs";
      await fs.mkdir(path.join(root, "scripts"));
      await fs.writeFile(
        path.join(root, script),
        [
          'import fs from "node:fs";',
          'import path from "node:path";',
          "import { linkSourcePluginDependencies } from " + JSON.stringify(linker) + ";",
          'const destination = path.resolve("dist/extensions/x/node_modules");',
          "fs.rmSync(destination, { recursive: true, force: true });",
          'linkSourcePluginDependencies(path.resolve("extensions/x"), destination);',
        ].join("\n"),
      );
      await fs.mkdir(path.join(root, "extensions/x"), { recursive: true });
      await fs.writeFile(
        path.join(root, "extensions/x/package.json"),
        JSON.stringify({ dependencies: { payload: "1" } }),
      );
      await git(root, "add", script, "extensions/x/package.json");
      await git(root, "commit", "-m", "candidate metadata entrypoint");
      base = await git(root, "rev-parse", "HEAD");
      let built = false;
      let exposed = false;
      let validated = false;
      const runCommand: CommandRunner = async (argv, options) => {
        if (argv[0] === "pnpm") {
          if (argv[1] === "build") {
            assert(options.cwd);
            const candidate = options.cwd;
            for (const directory of [
              "dist/control-ui",
              "extensions/x/node_modules",
              "node_modules/first",
            ]) {
              await fs.mkdir(path.join(candidate, directory), { recursive: true });
            }
            await writeFixtureFiles(candidate, {
              "dist/control-ui/index.html": "ready",
              "node_modules/first/index.js": "module.exports = 'old';",
            });
            await fs.symlink(
              path.join(candidate, "node_modules/first"),
              path.join(candidate, "extensions/x/node_modules/payload"),
              "junction",
            );
            const linked = await runCommandWithTimeout(["node", script], {
              ...options,
              cwd: candidate,
            });
            expect(linked.code, linked.stderr).toBe(0);
            built = true;
          }
          return { code: 0, stdout: argv[1] === "--version" ? "12.0.0" : "", stderr: "" };
        }
        return runCommandWithTimeout(argv, options);
      };
      const result = await prepare(runCommand, {
        prepareGitExposure: async (candidate) => {
          expect(built).toBe(true);
          await expectHead(root, base);
          const link = path.join(candidate, "extensions/x/node_modules/payload");
          await fs.rm(link);
          await fs.rm(path.join(candidate, "node_modules/first"), { recursive: true });
          if (corrupt) {
            await fs.symlink("payload", link);
          } else {
            await fs.mkdir(path.join(candidate, "node_modules/final"), { recursive: true });
            await writeFixtureFiles(candidate, {
              "node_modules/final/index.js": "module.exports = 'final';",
            });
            await fs.symlink(path.join(candidate, "node_modules/final"), link, "junction");
          }
          exposed = true;
        },
        validateCandidate: async (candidate) => {
          expect(exposed).toBe(true);
          const imported = await runCommandWithTimeout(
            [
              "node",
              "-e",
              'require("node:assert/strict").equal(require(require("node:path").resolve("dist/extensions/x/node_modules/payload")), "final");',
            ],
            { cwd: candidate, timeoutMs: 5000 },
          );
          expect(imported.code, imported.stderr).toBe(0);
          validated = true;
        },
      });
      expect(result.status).toBe(corrupt ? "error" : "ok");
      expect(validated).toBe(!corrupt);
      expectStep(steps, {
        name: "preflight-bundled-plugin-dependency-links",
        exitCode: corrupt ? 1 : 0,
      });
      await expectHead(root, base);
    },
  );

  it("refuses divergent main before install or copying operator inputs", async () => {
    const beforeSha = await commit("local.txt", "local\n");
    const targetRevision = await commitTarget("target.txt", "target\n");
    const copyBuildInputs = vi.fn(async () => {});

    expect(
      await preflight({ branch: "main", beforeSha, targetRevision, copyBuildInputs }),
    ).toMatchObject({ status: "error" });
    expect(installs).toEqual([]);
    expect(copyBuildInputs).not.toHaveBeenCalled();
    await expectHead(root, beforeSha);
    await expectFile(path.join(root, "local.txt"), "local\n");
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
      await expectHead(root, beforeSha);
      expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    },
  );

  it.each(["same-head", "updated", "working", "index", "committed"] as const)(
    "admits operator inputs only while candidate source stays selected (%s)",
    async (kind) => {
      const accepted = kind === "same-head" || kind === "updated";
      const targetRevision =
        kind === "same-head" ? base : await commitTarget("target.txt", "target\n");
      const result = await preflight({
        branch: "main",
        beforeSha: base,
        targetRevision,
        copyBuildInputs: async (candidate) => {
          await expectHead(candidate, targetRevision);
          await writeFixtureFiles(candidate, {
            "operator-input.txt": "operator input\n",
            ".fixture-env": "ignored input\n",
          });
        },
        validateCandidate: accepted
          ? undefined
          : async (candidate) => {
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

      if (accepted) {
        expect(result.status).toBe("ok");
        expect(builtInputs).toEqual([
          expect.objectContaining({
            "operator-input.txt": "operator input\n",
            ".fixture-env": "ignored input\n",
          }),
        ]);
        expect(installs).toEqual([["pnpm", "install", "--frozen-lockfile"]]);
      } else {
        expect(result.status).toBe("error");
        expect(prepared).toBeUndefined();
        expectStep(steps, {
          name:
            kind === "committed" ? "preflight-update-source-check" : "preflight-update-clean-check",
          exitCode: 1,
        });
      }
      await expectHead(root, base);
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
      expect({ installs, builtInputs }).toEqual({ installs: [], builtInputs: [] });
    },
  );
});
