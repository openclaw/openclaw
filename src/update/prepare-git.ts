import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import { readPackageVersion } from "../infra/package-json.js";
import { readBuiltGatewayBuildId } from "../infra/update-git-runtime.js";
import { fetchGitUpdateTarget } from "../infra/update-runner-git-target.js";
import type { RunStepOptions } from "../infra/update-runner-types.js";
import type { UpdateStepResult } from "../infra/update-step-result.js";
import { runCommandWithTimeout } from "../process/exec.js";

export type PrepareResult =
  | { ok: true; releaseRoot: string; buildId?: string; version: string }
  | { ok: false; reason: string; stderrTail: string };

/** One deadline includes fetch, dependencies, core build and UI build. */
export async function prepareGit(params: {
  checkout: string;
  sha: string;
  staging: string;
  node: string;
  timeoutMs: number;
  onStep?: (name: string) => void | Promise<void>;
}): Promise<PrepareResult> {
  const releaseRoot = path.join(params.staging, "openclaw");
  const deadline = Date.now() + params.timeoutMs;
  const env = {
    ...process.env,
    PATH: `${path.dirname(params.node)}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const steps: UpdateStepResult[] = [];
  let reason = "fetch-failed";
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) {
      throw new Error("Update preparation exceeded its deadline.");
    }
    return ms;
  };
  const runCommand: RunStepOptions["runCommand"] = (argv, options) =>
    runCommandWithTimeout(argv, { ...options, env, timeoutMs: remaining(), killProcessTree: true });
  const step = (name: string, argv: string[], cwd: string): RunStepOptions => ({
    name,
    argv,
    cwd,
    runCommand,
    timeoutMs: remaining(),
    env,
    stepIndex: steps.length,
    totalSteps: 5,
    results: steps,
    progress: {
      onStepStart: async ({ name: stepName }) => {
        await params.onStep?.(stepName);
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
    for (const [name, argv, cwd] of [
      [
        "worktree",
        ["git", "-C", params.checkout, "worktree", "add", "--detach", releaseRoot, params.sha],
        params.checkout,
      ],
      ["install", ["pnpm", "install", "--frozen-lockfile"], releaseRoot],
      ["build", ["pnpm", "build"], releaseRoot],
      ["ui-build", ["pnpm", "ui:build"], releaseRoot],
    ] as const) {
      reason = `${name}-failed`;
      await params.onStep?.(name);
      const result = await runCommand([...argv], { cwd, timeoutMs: remaining() });
      if (result.code !== 0 || result.killed || result.signal) {
        throw new Error(result.stderr || result.stdout || `${name} exited ${result.code}`);
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
      ["git", "-C", params.checkout, "worktree", "remove", "--force", releaseRoot],
      {
        timeoutMs: 30_000,
        killProcessTree: true,
      },
    ).catch(() => undefined);
    await fs.rm(params.staging, { recursive: true, force: true });
    return { ok: false, reason, stderrTail: formatErrorMessage(error).slice(-8192) };
  }
}
