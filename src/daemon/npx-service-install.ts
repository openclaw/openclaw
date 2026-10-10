import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { readPackageVersion } from "../infra/package-json.js";
import { runGlobalPackageUpdateSteps } from "../infra/package-update-steps.js";
import {
  collectInstalledGlobalPackageErrors,
  createGlobalInstallEnv,
  resolveGlobalInstallTarget,
} from "../infra/update-global.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import { runStep } from "../infra/update-runner-command.js";
import { runCommandWithTimeout } from "../process/exec.js";

/** npm exec owns its cache, so only a managed npm prefix may own a node service. */
export async function resolveDurableNodeEntrypoint(
  env: NodeJS.ProcessEnv,
  entrypoint = process.argv[1],
): Promise<string | undefined> {
  if (!entrypoint) {
    return undefined;
  }
  const resolved = await fs.realpath(entrypoint).catch(() => path.resolve(entrypoint));
  if (!resolved.split(path.sep).includes("_npx")) {
    return undefined;
  }
  const sourceRoot = await resolveOpenClawPackageRoot({ argv1: resolved });
  const version = sourceRoot ? await readPackageVersion(sourceRoot) : null;
  if (!version) {
    throw new Error(
      "Cannot determine the npm exec OpenClaw version for node service installation.",
    );
  }
  const layout = resolveNpmGlobalPrefixLayoutFromPrefix(path.join(resolveStateDir(env), "npm"));
  const packageRoot = path.join(layout.globalRoot, "openclaw");
  const errors = await collectInstalledGlobalPackageErrors({
    packageRoot,
    expectedVersion: version,
  });
  if (errors.length) {
    const installEnv = await createGlobalInstallEnv(env, { manager: "npm" });
    const target = await resolveGlobalInstallTarget({
      manager: "npm",
      runCommand: runCommandWithTimeout,
      timeoutMs: 30_000,
      env: installEnv,
    });
    await fs.mkdir(layout.globalRoot, { recursive: true });
    const result = await runGlobalPackageUpdateSteps({
      installTarget: { ...target, globalRoot: layout.globalRoot, packageRoot },
      installSpec: `openclaw@${version}`,
      requirePackageReplacement: true,
      packageName: "openclaw",
      packageRoot,
      runCommand: runCommandWithTimeout,
      runStep: (step) => runStep({ ...step, runCommand: runCommandWithTimeout }),
      timeoutMs: 30_000,
      workTimeoutMs: null,
      env: installEnv,
    });
    if (result.failedStep) {
      throw new Error(
        `Cannot install durable OpenClaw ${version}: ${result.failedStep.stderrTail || result.failedStep.name}`,
      );
    }
  }
  return path.join(packageRoot, "openclaw.mjs");
}
