import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import type { PackageUpdateTransaction } from "../infra/package-update-swap-contract.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import type { PlannedCliEntrypoint } from "./program-args.js";

const realpathOrResolve = (target: string) => fs.realpath(target).catch(() => path.resolve(target));

/**
 * One-off runners own their copies and may evict them, so a service must never point into
 * one or keep one on its PATH: npx (`<cache>/_npx/<hash>`), pnpm 9+ dlx
 * (`<cache>/dlx/<key>`), Yarn Berry and pnpm 7-8 dlx (`dlx-<pid>`, removed on exit), and
 * bunx (`.bunx-<uid>` on POSIX, `<tmp>\\bunx-<uid>-<package>` on Windows). Other temp-dir
 * paths are not runner caches. Takes a realpath.
 */
export function isDisposableInstallPath(resolved: string): boolean {
  return resolved
    .split(path.sep)
    .some(
      (segment) =>
        segment === "_npx" ||
        segment === "dlx" ||
        /^dlx-\d+$/u.test(segment) ||
        /^\.?bunx-/u.test(segment),
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

/**
 * Launcher folder of the durable copy, for the service PATH: when it is installed, or when
 * the planned install will (re)place it.
 */
export function resolveDurableServiceBinDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  options: { planned?: boolean } = {},
): string | undefined {
  const { binDir } = resolveDurableLayout(env).layout;
  const launcher = path.join(binDir, platform === "win32" ? "openclaw.cmd" : "openclaw");
  return options.planned || fsSync.existsSync(launcher) ? binDir : undefined;
}

/** A durable copy that a service install must (re)place before the service runs it. */
export type DurableServiceCliReplacement = {
  version: string;
  globalRoot: string;
  packageRoot: string;
  /** The entrypoint the service will run; the staged copy must contain it. */
  entrypoint: string;
};

/**
 * Entrypoint a service should run instead of a disposable CLI copy, or undefined when
 * this CLI is already durable.
 *
 * Neither mode installs. `install: false` (Doctor, repair, install comparisons) reuses an
 * existing copy only when it matches this CLI's version and passes the package integrity
 * checks, and throws DurableServiceCliError naming the explicit reinstall otherwise.
 * `install: true` instead returns the replacement for installDurableServiceCli to perform
 * inside the service install, after planning has validated everything else.
 */
export async function resolveDurableServiceCli(
  env: NodeJS.ProcessEnv,
  options: { install: boolean; service: "gateway" | "node" },
  entrypoint = process.argv[1],
): Promise<
  | { entrypoint: string | PlannedCliEntrypoint; replacement?: DurableServiceCliReplacement }
  | undefined
> {
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
  // Package-inspection machinery loads only for a disposable CLI.
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
  if (!sourceRoot || !version) {
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
    return { entrypoint: durableEntrypoint };
  }
  if (!options.install) {
    throw new DurableServiceCliError(
      `The background service's OpenClaw copy at ${packageRoot} cannot be reused (${errors.slice(0, 2).join("; ")}). Reinstall it with: ${formatDurableInstallCommand(version, "gateway install --force", env)}`,
    );
  }
  // The copy is published only inside the service install, so plan its entry from this
  // CLI's own files: the same version has the same layout.
  const { planCliEntrypoint } = await import("./program-args.js");
  const planned = await planCliEntrypoint({
    sourceEntrypoint: entrypoint,
    sourceRoot,
    packageRoot,
    service: options.service,
  });
  return {
    entrypoint: planned,
    replacement: {
      version,
      globalRoot: layout.globalRoot,
      packageRoot,
      entrypoint: planned.planned,
    },
  };
}

/**
 * Runs a service install whose plan carries a durable-copy replacement.
 *
 * npm stages and verifies the new copy first while an existing service keeps serving the old
 * one. The swap waits at the package updater's activation gate until the service install's
 * mutation hook, which runs under the service operation lock just before the service's own
 * runtime-pin checks and definition write. The previous copy stays backed up until the
 * install settles: if the install fails, the previous copy is restored (a first install keeps
 * its new copy, which nothing else uses); if it succeeds, the backup retires only once the
 * service is verified loaded.
 *
 * Gateway and node services share the copy but not a service lock, so one package lock covers
 * staging through settlement: a failed install's restore cannot undo another install's swap.
 * `openclaw update` does not take this lock; it updates the copy under its own ownership.
 */
export async function installDurableServiceCli(params: {
  env: NodeJS.ProcessEnv;
  replacement: DurableServiceCliReplacement | undefined;
  install: (beforeMutation?: () => Promise<void>) => Promise<void>;
  verify: () => Promise<boolean>;
  warn: (message: string) => void;
}): Promise<void> {
  if (!params.replacement) {
    await params.install();
    return;
  }
  const replacement = params.replacement;
  const { prefix } = resolveDurableLayout(params.env).layout;
  await fs.mkdir(prefix, { recursive: true });
  const { withFileLock } = await import("../infra/file-lock.js");
  await withFileLock(
    path.join(prefix, ".openclaw-service-install"),
    {
      // A waiting install sits behind another's npm staging and service install, so the
      // budget is minutes. Only a definitely dead holder is reclaimed, never by age.
      retries: { retries: 600, factor: 1.2, minTimeout: 100, maxTimeout: 1_000 },
      stale: 30_000,
      staleRecovery: "remove-if-definitely-stale",
    },
    () => installUnderPackageLock({ ...params, replacement }),
  );
}

async function installUnderPackageLock(
  params: Parameters<typeof installDurableServiceCli>[0] & {
    replacement: DurableServiceCliReplacement;
  },
): Promise<void> {
  const replacement = params.replacement;
  // Read under the lock: an install that waited may now replace a copy another one made.
  const replacesExisting = await fs.access(replacement.packageRoot).then(
    () => true,
    () => false,
  );
  const staged = await stageDurableCopy(params.env, replacement);
  let activation: Promise<void> | undefined;
  let swapped = false;
  let outcome: "installed" | "verified" | "failed" = "failed";
  try {
    await params.install(
      () =>
        (activation ??= staged.activate().then(() => {
          swapped = true;
        })),
    );
    if (!activation) {
      throw new Error(
        "The service install finished without its mutation hook; the durable OpenClaw copy was not installed.",
      );
    }
    // A throwing verify still leaves an installed service.
    outcome = "installed";
    outcome = (await params.verify()) ? "verified" : "installed";
  } finally {
    // Cleanup reports through warn so it never replaces the install's own error.
    try {
      const warnings = !activation
        ? await staged.cancel()
        : await staged.settle(
            outcome === "verified"
              ? "retire"
              : outcome === "installed"
                ? "retain"
                : // A failed first install keeps its swapped-in copy: nothing to restore.
                  swapped && !replacesExisting
                  ? "retire"
                  : "restore",
          );
      warnings.forEach(params.warn);
    } catch (error) {
      params.warn(`Durable OpenClaw copy cleanup failed: ${String(error)}`);
    }
  }
}

async function stageDurableCopy(env: NodeJS.ProcessEnv, replacement: DurableServiceCliReplacement) {
  const [
    { runGlobalPackageUpdateSteps },
    { createGlobalInstallEnv, resolveGlobalInstallTarget },
    { runStep },
    { runCommandWithTimeout },
    { applyPathPrepend },
    { createDeferredCore },
  ] = await Promise.all([
    import("../infra/package-update-steps.js"),
    import("../infra/update-global.js"),
    import("../infra/update-runner-command.js"),
    import("../process/exec.js"),
    import("../infra/path-prepend.js"),
    import("../shared/deferred.js"),
  ]);
  const installEnv = await createGlobalInstallEnv(env, { manager: "npm" });
  // npm runs lifecycle scripts (openclaw's runtime guard) with the first `node` on
  // PATH, which can be an older system Node; pin them to this runtime as update does.
  applyPathPrepend(installEnv, [path.dirname(process.execPath)]);
  const target = await resolveGlobalInstallTarget({
    manager: "npm",
    runCommand: runCommandWithTimeout,
    timeoutMs: 30_000,
    env: installEnv,
  });
  await fs.mkdir(replacement.globalRoot, { recursive: true });
  const prepared = createDeferredCore();
  const gate = createDeferredCore<boolean>();
  const cancelled = new Error("Durable OpenClaw copy replacement cancelled before activation");
  let transaction: PackageUpdateTransaction | undefined;
  const failure = (step: { name: string; stderrTail?: string | null }) =>
    new Error(
      `Cannot install durable OpenClaw ${replacement.version} for the background service: ${step.stderrTail || step.name}`,
    );
  const completed = runGlobalPackageUpdateSteps({
    installTarget: {
      ...target,
      globalRoot: replacement.globalRoot,
      packageRoot: replacement.packageRoot,
    },
    installSpec: `openclaw@${replacement.version}`,
    requirePackageReplacement: true,
    packageName: "openclaw",
    packageRoot: replacement.packageRoot,
    // Refuse before the swap a candidate without the entry the planned service runs.
    validateCandidate: async (candidateRoot) => {
      const entry = path.join(
        candidateRoot,
        path.relative(replacement.packageRoot, replacement.entrypoint),
      );
      return (await fs.access(entry).then(
        () => true,
        () => false,
      ))
        ? []
        : [
            {
              name: "durable-cli-entrypoint",
              command: `verify ${entry}`,
              cwd: candidateRoot,
              durationMs: 0,
              exitCode: 1,
              stderrTail: `The staged copy has no ${path.relative(candidateRoot, entry)}, which the service would run.`,
            },
          ];
    },
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
    beforeActivate: async () => {
      prepared.resolve();
      if (!(await gate.promise)) {
        throw cancelled;
      }
    },
    // A retained transaction keeps the previous copy until settle restores or retires it.
    onTransaction: (registered) => {
      transaction = registered;
    },
  });
  const outcome = await Promise.race([prepared.promise.then(() => null), completed]);
  if (outcome) {
    throw failure(outcome.failedStep ?? { name: "the package update stopped before activation" });
  }
  // Service install has no update-run fence; the service operation lock serializes it.
  const unfenced = () => undefined;
  return {
    activate: async () => {
      gate.resolve(true);
      const result = await completed;
      if (result.failedStep) {
        throw failure(result.failedStep);
      }
    },
    cancel: async (): Promise<string[]> => {
      gate.resolve(false);
      // Staging cleanup must not replace the install failure that caused the cancel.
      return await completed.then(
        () => [],
        (error: unknown) =>
          error === cancelled ? [] : [`Durable OpenClaw staging cleanup failed: ${String(error)}`],
      );
    },
    /**
     * restore: put the previous copy back (or remove a failed swap's partial copy);
     * retain: keep the new copy and the backup, for an install not verified loaded;
     * retire: keep the new copy and drop the backup.
     */
    settle: async (decision: "restore" | "retain" | "retire"): Promise<string[]> => {
      await completed.catch(() => undefined);
      if (!transaction) {
        return [];
      }
      const warnings: string[] = [];
      if (decision === "restore") {
        const restored = await transaction.rollback(unfenced);
        if (restored.exitCode !== 0) {
          warnings.push(
            `Could not restore the previous durable OpenClaw copy: ${restored.stderrTail ?? restored.name}`,
          );
        }
      }
      const retirement = await transaction.complete(
        { activationVerified: decision !== "retain" },
        unfenced,
      );
      if (retirement && retirement.exitCode !== 0) {
        warnings.push(retirement.stderrTail ?? retirement.name);
      }
      return warnings;
    },
  };
}
