import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";

const realpathOrResolve = (target: string) => fs.realpath(target).catch(() => path.resolve(target));

/**
 * npx, pnpm dlx, and temp-dir runners (bunx) own their copies and may evict them,
 * so a service must never point into one or keep one on its PATH.
 * Takes a realpath; the temp dir is compared by its realpath too.
 */
export function isDisposableInstallPath(resolved: string): boolean {
  const segments = resolved.split(path.sep);
  let tmp = os.tmpdir();
  try {
    tmp = fsSync.realpathSync(tmp);
  } catch {}
  return (
    segments.includes("_npx") ||
    segments.includes("dlx") ||
    resolved.startsWith(`${path.resolve(tmp)}${path.sep}`)
  );
}

export async function isDisposableEntrypoint(entrypoint: string): Promise<boolean> {
  return isDisposableInstallPath(await realpathOrResolve(entrypoint));
}

/** The command that installs (or reinstalls) the durable copy, for users without openclaw on PATH. */
export function formatDurableInstallCommand(
  version: string,
  args: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const command = formatCliCommand(`openclaw ${args}`, env);
  return `npx ${command.replace(/^openclaw\b/u, `openclaw@${version}`)}`;
}

/** A durable copy exists but fails its version or integrity check; only an install replaces it. */
export class DurableServiceCliError extends Error {
  override name = "DurableServiceCliError";
}

/** The durable copy lives in an npm prefix under the state dir, which `openclaw update` updates in place. */
function resolveDurableLayout(env: NodeJS.ProcessEnv) {
  const layout = resolveNpmGlobalPrefixLayoutFromPrefix(path.join(resolveStateDir(env), "npm"));
  const packageRoot = path.join(layout.globalRoot, "openclaw");
  return { layout, packageRoot, entrypoint: path.join(packageRoot, "openclaw.mjs") };
}

/** Launcher folder of an installed durable copy, for the service PATH. */
export function resolveDurableServiceBinDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const { binDir } = resolveDurableLayout(env).layout;
  const launcher = path.join(binDir, platform === "win32" ? "openclaw.cmd" : "openclaw");
  return fsSync.existsSync(launcher) ? binDir : undefined;
}

/**
 * Entrypoint a service should run instead of a disposable CLI copy, or undefined when
 * this CLI is already durable.
 *
 * `install: false` (planning, Doctor, repair) never installs: it reuses an existing copy
 * only when it matches this CLI's version and passes the package integrity checks, and
 * throws DurableServiceCliError naming the explicit reinstall otherwise.
 */
export async function resolveDurableServiceEntrypoint(
  env: NodeJS.ProcessEnv,
  options: { install: boolean },
  entrypoint = process.argv[1],
): Promise<string | undefined> {
  if (!entrypoint || !(await isDisposableEntrypoint(entrypoint))) {
    return undefined;
  }
  const { layout, packageRoot, entrypoint: durableEntrypoint } = resolveDurableLayout(env);
  const exists = await fs.access(durableEntrypoint).then(
    () => true,
    () => false,
  );
  if (!options.install && !exists) {
    return undefined;
  }
  // Package-inspection and install machinery loads only for a disposable CLI.
  const [
    { resolveOpenClawPackageRoot },
    { collectPackageDistContentInventoryErrors },
    { readPackageVersion },
    { collectInstalledGlobalPackageErrors },
  ] = await Promise.all([
    import("../infra/openclaw-root.js"),
    import("../infra/package-dist-inventory.js"),
    import("../infra/package-json.js"),
    import("../infra/update-global.js"),
  ]);
  const sourceRoot = await resolveOpenClawPackageRoot({
    argv1: await realpathOrResolve(entrypoint),
  });
  const version = sourceRoot ? await readPackageVersion(sourceRoot) : null;
  if (!version) {
    throw new Error("Cannot determine the running OpenClaw version for service installation.");
  }
  const errors = exists
    ? await collectInstalledGlobalPackageErrors({ packageRoot, expectedVersion: version })
    : ["missing"];
  if (errors.length === 0) {
    errors.push(
      ...(await collectPackageDistContentInventoryErrors(packageRoot).catch((error: unknown) => [
        String(error),
      ])),
    );
  }
  if (errors.length === 0) {
    return durableEntrypoint;
  }
  if (!options.install) {
    throw new DurableServiceCliError(
      `The background service's OpenClaw copy at ${packageRoot} cannot be reused (${errors.slice(0, 2).join("; ")}). Reinstall it with: ${formatDurableInstallCommand(version, "gateway install --force", env)}`,
    );
  }
  await installDurableCopy({ env, version, globalRoot: layout.globalRoot, packageRoot });
  return durableEntrypoint;
}

async function installDurableCopy(params: {
  env: NodeJS.ProcessEnv;
  version: string;
  globalRoot: string;
  packageRoot: string;
}): Promise<void> {
  const [
    { runGlobalPackageUpdateSteps },
    { createGlobalInstallEnv, resolveGlobalInstallTarget },
    { runStep },
    { runCommandWithTimeout },
    { applyPathPrepend },
  ] = await Promise.all([
    import("../infra/package-update-steps.js"),
    import("../infra/update-global.js"),
    import("../infra/update-runner-command.js"),
    import("../process/exec.js"),
    import("../infra/path-prepend.js"),
  ]);
  const installEnv = await createGlobalInstallEnv(params.env, { manager: "npm" });
  // npm runs lifecycle scripts (openclaw's runtime guard) with the first `node` on
  // PATH, which can be an older system Node; pin them to this runtime as update does.
  applyPathPrepend(installEnv, [path.dirname(process.execPath)]);
  const target = await resolveGlobalInstallTarget({
    manager: "npm",
    runCommand: runCommandWithTimeout,
    timeoutMs: 30_000,
    env: installEnv,
  });
  await fs.mkdir(params.globalRoot, { recursive: true });
  const result = await runGlobalPackageUpdateSteps({
    installTarget: { ...target, globalRoot: params.globalRoot, packageRoot: params.packageRoot },
    installSpec: `openclaw@${params.version}`,
    requirePackageReplacement: true,
    packageName: "openclaw",
    packageRoot: params.packageRoot,
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
      `Cannot install durable OpenClaw ${params.version} for the background service: ${result.failedStep.stderrTail || result.failedStep.name}`,
    );
  }
}
