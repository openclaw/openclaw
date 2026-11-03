import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";

const realpathOrResolve = (target: string) => fs.realpath(target).catch(() => path.resolve(target));

/**
 * npx, pnpm dlx, and temp-dir runners (bunx) own their copies and may evict them,
 * so a service must never point into one.
 */
export async function isDisposableEntrypoint(entrypoint: string): Promise<boolean> {
  const resolved = await realpathOrResolve(entrypoint);
  const segments = resolved.split(path.sep);
  return (
    segments.includes("_npx") ||
    segments.includes("dlx") ||
    resolved.startsWith(`${await realpathOrResolve(os.tmpdir())}${path.sep}`)
  );
}

/**
 * Entrypoint a service should run instead of a disposable CLI copy, or undefined when
 * this CLI is already durable. The copy lives in an npm prefix under the state dir,
 * which `openclaw update` recognizes and updates in place.
 *
 * `install: false` only reuses a copy that already exists, so read-only planners
 * (Doctor) never install packages or replace files under a running service.
 */
export async function resolveDurableServiceEntrypoint(
  env: NodeJS.ProcessEnv,
  options: { install: boolean },
  entrypoint = process.argv[1],
): Promise<string | undefined> {
  if (!entrypoint || !(await isDisposableEntrypoint(entrypoint))) {
    return undefined;
  }
  const layout = resolveNpmGlobalPrefixLayoutFromPrefix(path.join(resolveStateDir(env), "npm"));
  const packageRoot = path.join(layout.globalRoot, "openclaw");
  const durableEntrypoint = path.join(packageRoot, "openclaw.mjs");
  if (!options.install) {
    return (await fs.access(durableEntrypoint).then(
      () => true,
      () => false,
    ))
      ? durableEntrypoint
      : undefined;
  }
  // Package-install machinery loads only when an install caller needs it.
  const [
    { resolveOpenClawPackageRoot },
    { collectPackageDistContentInventoryErrors },
    { readPackageVersion },
    { runGlobalPackageUpdateSteps },
    { collectInstalledGlobalPackageErrors, createGlobalInstallEnv, resolveGlobalInstallTarget },
    { runStep },
    { runCommandWithTimeout },
  ] = await Promise.all([
    import("../infra/openclaw-root.js"),
    import("../infra/package-dist-inventory.js"),
    import("../infra/package-json.js"),
    import("../infra/package-update-steps.js"),
    import("../infra/update-global.js"),
    import("../infra/update-runner-command.js"),
    import("../process/exec.js"),
  ]);
  const sourceRoot = await resolveOpenClawPackageRoot({
    argv1: await realpathOrResolve(entrypoint),
  });
  const version = sourceRoot ? await readPackageVersion(sourceRoot) : null;
  if (!version) {
    throw new Error("Cannot determine the running OpenClaw version for service installation.");
  }
  const errors = await collectInstalledGlobalPackageErrors({
    packageRoot,
    expectedVersion: version,
  });
  const reusable =
    errors.length === 0 &&
    (await collectPackageDistContentInventoryErrors(packageRoot).then(
      (contentErrors) => contentErrors.length === 0,
      () => false,
    ));
  if (!reusable) {
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
      runStep: (step) =>
        runStep({
          ...step,
          cwd: step.cwd ?? process.cwd(),
          runCommand: runCommandWithTimeout,
          stepIndex: 0,
          totalSteps: 0,
        }),
      timeoutMs: 30_000,
      workTimeoutMs: null,
      env: installEnv,
    });
    if (result.failedStep) {
      throw new Error(
        `Cannot install durable OpenClaw ${version} for the background service: ${result.failedStep.stderrTail || result.failedStep.name}`,
      );
    }
  }
  return durableEntrypoint;
}
