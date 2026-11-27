import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage, hasErrnoCode } from "../infra/errors.js";
import { gitCommandArgv, gitReadOnlyEnvironment } from "../infra/git-exec.js";
import {
  irohNativeBinaryName,
  irohNativeBuildInputs,
  isIrohBuildCurrent,
} from "../infra/iroh-native-build.js";
import { hasPackageScript, readPackageVersion } from "../infra/package-json.js";
import { readBuiltGatewayBuildId } from "../infra/update-git-runtime.js";
import { resolveUpdateBuildManager } from "../infra/update-package-manager.js";
import { shouldInstallWithoutScriptsOnWindows } from "../infra/update-runner-git-commands.js";
import { fetchGitUpdateTarget } from "../infra/update-runner-git-target.js";
import type { RunStepOptions } from "../infra/update-runner-types.js";
import type { UpdateStepResult } from "../infra/update-step-result.js";
import { runCommandWithTimeout } from "../process/exec.js";

export type PrepareResult =
  | { ok: true; releaseRoot: string; buildId?: string; version: string }
  | { ok: false; reason: string; stderrTail: string };

const IROH_CRATE = "crates/openclaw-iroh-node";
const IROH_BUILD_STEP = "build:iroh";

async function hasNativeArtifact(file: string): Promise<boolean> {
  const stat = await fs.lstat(file).catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return undefined;
  });
  return stat?.isFile() === true && stat.size > 0;
}

async function selectIrohArtifact(
  roots: string[],
  releaseRoot: string,
  binary: string,
  gitRead: (cwd: string, args: string[]) => Promise<string | undefined>,
): Promise<{ reuse?: string } | undefined> {
  const candidates: string[] = [];
  for (const root of new Set(roots)) {
    if (await hasNativeArtifact(path.join(root, IROH_CRATE, binary))) {
      candidates.push(root);
    }
  }
  if (candidates.length === 0) {
    return undefined; // Native builds are opt-in.
  }

  const crateTree = ["rev-parse", "--verify", "--quiet", "HEAD:" + IROH_CRATE];
  const targetTree = await gitRead(releaseRoot, crateTree);
  if (targetTree) {
    for (const root of candidates) {
      const crate = path.join(root, IROH_CRATE);
      // A pulled checkout may have a matching HEAD but a binary from before the pull.
      if ((await gitRead(root, crateTree)) !== targetTree || !isIrohBuildCurrent(crate, binary)) {
        continue;
      }
      // The napi build can rewrite its generated JS loader; only inspect native inputs here.
      const dirty = await gitRead(root, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        ...irohNativeBuildInputs.map((file) => IROH_CRATE + "/" + file),
      ]);
      if (dirty === "") {
        return { reuse: path.join(crate, binary) };
      }
    }
  }
  return {};
}

/** One deadline includes fetch, dependencies and the full build, including opt-in iroh. */
export async function prepareGit(params: {
  checkout: string;
  runningRoot: string;
  sha: string;
  staging: string;
  node: string;
  timeoutMs: number;
  onStep?: (name: string, status: "in_progress" | "completed") => void | Promise<void>;
}): Promise<PrepareResult> {
  const releaseRoot = path.join(params.staging, "openclaw");
  const deadline = Date.now() + params.timeoutMs;
  const env = {
    ...process.env,
    PATH: `${path.dirname(params.node)}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const steps: UpdateStepResult[] = [];
  let reason = "fetch-failed";
  let cleanupManager: (() => Promise<void>) | undefined;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) {
      throw new Error("Update preparation exceeded its deadline.");
    }
    return ms;
  };
  const runCommand: RunStepOptions["runCommand"] = (argv, options) =>
    runCommandWithTimeout(argv, {
      ...options,
      env: options.env ?? env,
      timeoutMs: remaining(),
      killProcessTree: true,
    });
  const step = (name: string, argv: string[], cwd: string): RunStepOptions => ({
    name,
    argv,
    cwd,
    runCommand,
    timeoutMs: remaining(),
    env,
    stepIndex: steps.length,
    totalSteps: 4,
    results: steps,
    progress: {
      onStepStart: async ({ name: stepName }) => {
        await params.onStep?.(stepName, "in_progress");
      },
      onStepComplete: async ({ name: stepName, exitCode }) => {
        if (exitCode === 0) {
          await params.onStep?.(stepName, "completed");
        }
      },
    },
  });
  try {
    await fs.mkdir(params.staging, { recursive: true });
    const fetched = await fetchGitUpdateTarget({
      root: params.checkout,
      channel: "dev",
      devTarget: { mode: "detached", ref: params.sha },
      name: "fetch",
      step,
      workStep: step,
      steps,
    });
    if (!fetched.ok) {
      throw new Error(steps.at(-1)?.stderrTail || "Could not fetch the selected Git revision.");
    }
    const run = async (
      name: string,
      argv: string[],
      cwd: string,
      commandEnv: NodeJS.ProcessEnv = env,
    ) => {
      reason = `${name}-failed`;
      await params.onStep?.(name, "in_progress");
      const result = await runCommand(argv, { cwd, env: commandEnv, timeoutMs: remaining() });
      if (result.code !== 0 || result.killed || result.signal) {
        throw new Error(result.stderr || result.stdout || `${name} exited ${result.code}`);
      }
      await params.onStep?.(name, "completed");
    };
    await run(
      "worktree",
      // Fixture paths in the tree exceed MAX_PATH under the release root; the Git owner enables long paths.
      gitCommandArgv(params.checkout, ["worktree", "add", "--detach", releaseRoot, params.sha]),
      params.checkout,
    );
    // The target's packageManager pin selects pnpm; installers leave no global pnpm on PATH.
    reason = "package-manager-unavailable";
    const manager = await resolveUpdateBuildManager(runCommand, releaseRoot, remaining(), env, {
      timeoutMs: remaining(),
    });
    if (manager.kind !== "resolved" || manager.manager !== "pnpm") {
      throw new Error(
        `Could not provide the target's pnpm (${manager.kind === "resolved" ? manager.manager : manager.reason}). Install pnpm or enable Corepack, then retry the update.`,
      );
    }
    cleanupManager = manager.cleanup;
    const pnpmEnv = manager.env ?? env;
    await run(
      "install",
      [
        "pnpm",
        "install",
        "--frozen-lockfile",
        ...(shouldInstallWithoutScriptsOnWindows("pnpm") ? ["--ignore-scripts"] : []),
      ],
      releaseRoot,
      pnpmEnv,
    );
    await run("build", ["pnpm", "build"], releaseRoot, pnpmEnv);
    reason = IROH_BUILD_STEP + "-failed";
    const binary = irohNativeBinaryName();
    const iroh = await selectIrohArtifact(
      [params.runningRoot, params.checkout],
      releaseRoot,
      binary,
      async (cwd, args) => {
        const result = await runCommand(gitCommandArgv(cwd, args), {
          cwd,
          env: gitReadOnlyEnvironment(args, { ...env, GIT_OPTIONAL_LOCKS: "0" }),
          timeoutMs: remaining(),
        });
        return result.code === 0 && !result.killed && !result.signal
          ? result.stdout.trim()
          : undefined;
      },
    );
    if (iroh) {
      const destination = path.join(releaseRoot, IROH_CRATE, binary);
      if (iroh.reuse) {
        remaining();
        await fs.copyFile(iroh.reuse, destination, fsConstants.COPYFILE_EXCL);
        remaining();
      } else {
        if (!(await hasPackageScript(releaseRoot, IROH_BUILD_STEP))) {
          throw new Error(
            "The target Git revision does not define pnpm build:iroh. Select a revision that can build the OpenClaw ID transport.",
          );
        }
        // The service can inherit an override that would otherwise win over the crate pin.
        await run(IROH_BUILD_STEP, ["pnpm", IROH_BUILD_STEP], releaseRoot, {
          ...pnpmEnv,
          RUSTUP_TOOLCHAIN: undefined,
        });
        if (!(await hasNativeArtifact(destination))) {
          throw new Error(
            "pnpm build:iroh did not produce the expected OpenClaw ID binding: " + binary,
          );
        }
      }
    }
    reason = "metadata-failed";
    const version = await readPackageVersion(releaseRoot);
    if (!version) {
      throw new Error("Prepared release has no package version.");
    }
    const buildId = await readBuiltGatewayBuildId(releaseRoot);
    return { ok: true, releaseRoot, version, ...(buildId ? { buildId } : {}) };
  } catch (error) {
    // Git owns its worktree registration; remove it before removing the staging prefix.
    await runCommandWithTimeout(
      gitCommandArgv(params.checkout, ["worktree", "remove", "--force", releaseRoot]),
      {
        timeoutMs: 30_000,
        killProcessTree: true,
      },
    ).catch(() => undefined);
    await fs.rm(params.staging, { recursive: true, force: true });
    return { ok: false, reason, stderrTail: formatErrorMessage(error).slice(-8192) };
  } finally {
    await cleanupManager?.();
  }
}
