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

/** The durable copy is missing or fails its version or integrity check; only an install replaces it. */
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

/**
 * The durable copy a service install runs. Despite the name, the install reuses a copy that
 * still serves this version when it checks it under the package lock, and replaces it otherwise.
 */
export type DurableServiceCliReplacement = {
  version: string;
  globalRoot: string;
  packageRoot: string;
  /** The entrypoint the service will run; a replacement must contain it. */
  entrypoint: string;
};

/** Why the copy at `packageRoot` cannot serve `version`; empty when it can be reused. */
async function collectDurableCopyErrors(packageRoot: string, version: string): Promise<string[]> {
  const exists = await fs.access(path.join(packageRoot, "openclaw.mjs")).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return ["missing"];
  }
  const [{ collectPackageDistContentInventoryErrors }, { collectInstalledGlobalPackageErrors }] =
    await Promise.all([
      import("../infra/package-dist-inventory.js"),
      import("../infra/update-global.js"),
    ]);
  const errors = await collectInstalledGlobalPackageErrors({
    packageRoot,
    expectedVersion: version,
  });
  if (errors.length > 0) {
    return errors;
  }
  return await collectPackageDistContentInventoryErrors(packageRoot).catch((error: unknown) => [
    String(error),
  ]);
}

/**
 * Entrypoint a service should run instead of a disposable CLI copy, or undefined when
 * this CLI is already durable.
 *
 * Neither mode installs. `install: false` (Doctor, repair, install comparisons) reuses an
 * existing copy only when it matches this CLI's version and passes the package integrity
 * checks, and throws DurableServiceCliError naming the explicit reinstall otherwise, including
 * when the copy is missing: a disposable CLI is never a service's entrypoint.
 * `install: true` returns the replacement for installDurableServiceCli, which checks the copy
 * under the package lock and reuses or replaces it inside the service install.
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
  // Package-inspection machinery loads only for a disposable CLI.
  const [{ resolveOpenClawPackageRoot }, { readPackageVersion }] = await Promise.all([
    import("../infra/openclaw-root.js"),
    import("../infra/package-json.js"),
  ]);
  const sourceRoot = await resolveOpenClawPackageRoot({
    argv1: await realpathOrResolve(entrypoint),
  });
  const version = sourceRoot ? await readPackageVersion(sourceRoot) : null;
  if (!sourceRoot || !version) {
    throw new Error("Cannot determine the running OpenClaw version for service installation.");
  }
  if (!options.install) {
    const errors = await collectDurableCopyErrors(packageRoot, version);
    if (errors.length === 0) {
      return { entrypoint: durableEntrypoint };
    }
    throw new DurableServiceCliError(
      `The background service's OpenClaw copy at ${packageRoot} cannot be reused (${errors.slice(0, 2).join("; ")}). Reinstall it with: ${formatDurableInstallCommand(version, "gateway install --force", env)}`,
    );
  }
  // Whether the copy is reused is decided under the package lock, and a replacement is
  // published only inside the service install, so plan the entry from this CLI's own
  // files: the same version has the same layout.
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
 * Under the package lock the copy is checked again: a copy that still serves this version is
 * reused as is. Otherwise npm stages and verifies the new copy first while an existing service
 * keeps serving the old one. The swap waits at the package updater's activation gate until the service install's
 * mutation hook, which runs under the service operation lock just before the service's own
 * runtime-pin checks and definition write. The previous copy stays backed up until the
 * install settles. It is restored only when native recovery calls `beforeRecovery`, which it
 * does after stopping the replacement and before restarting the previous service. Any other
 * failure keeps the new copy and the backup and warns (a first install has no backup); a
 * successful install retires the backup once the service is verified loaded.
 *
 * Gateway and node services share the copy but not a service lock, so one package lock covers
 * the check, staging and settlement, including a reuse: a failed install's restore cannot undo
 * another install's swap or the copy another install's service now runs.
 * `openclaw update` does not take this lock; it updates the copy under its own ownership.
 */
export async function installDurableServiceCli(params: {
  env: NodeJS.ProcessEnv;
  replacement: DurableServiceCliReplacement | undefined;
  /** Passes both hooks to service.install as `beforeMutation` and `beforeRecovery`. */
  install: (
    beforeMutation?: () => Promise<void>,
    beforeRecovery?: () => Promise<void>,
  ) => Promise<void>;
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
  // Read under the lock: an install that waited sees the copy other installs left behind.
  if ((await collectDurableCopyErrors(replacement.packageRoot, replacement.version)).length === 0) {
    await params.install();
    return;
  }
  const replacesExisting = await fs.access(replacement.packageRoot).then(
    () => true,
    () => false,
  );
  const staged = await stageDurableCopy(params.env, replacement);
  let activation: Promise<void> | undefined;
  let swapped = false;
  let settled = false;
  let outcome: "installed" | "verified" | "failed" = "failed";
  // Cleanup reports through warn so it never replaces the install's own error.
  const settle = async (decision: "restore" | "retain" | "retire") => {
    settled = true;
    try {
      for (const warning of await staged.settle(decision)) {
        params.warn(warning);
      }
    } catch (error) {
      params.warn(`Durable OpenClaw copy cleanup failed: ${String(error)}`);
    }
  };
  // The previous copy comes back only on proof that native recovery settled: it calls this
  // hook after stopping the replacement and before restarting the previous service. Every
  // other failure after publication keeps the new copy and its backup (see finally).
  const beforeRecovery = async () => {
    if (!activation || settled) {
      return;
    }
    await activation.catch(() => undefined);
    if (swapped) {
      // A first install has no previous copy to restore and keeps its new one.
      await settle(replacesExisting ? "restore" : "retire");
    }
  };
  try {
    await params.install(
      () =>
        (activation ??= staged.activate().then(() => {
          swapped = true;
        })),
      beforeRecovery,
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
    if (!activation) {
      try {
        for (const warning of await staged.cancel()) {
          params.warn(warning);
        }
      } catch (error) {
        params.warn(`Durable OpenClaw copy cleanup failed: ${String(error)}`);
      }
    } else if (!settled && outcome === "failed" && replacesExisting && staged.published()) {
      // No proof that native recovery settled: the replacement may still run on this copy, or
      // the service may run it successfully. Keep the copy and its backup for the operator.
      params.warn(
        `The service install failed without a settled service recovery, so the durable OpenClaw copy at ${replacement.packageRoot} was left as installed and the previous copy's backup was kept. Check the service, then rerun the install.`,
      );
      await settle("retain");
    } else if (!settled) {
      // A failed first install has nothing to restore and keeps its new copy.
      await settle(outcome === "installed" ? "retain" : "retire");
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
  // `openclaw update` does not take the package lock and can publish its own copy meanwhile.
  // Every rollback this install starts is fenced, whether its publication completed, stopped
  // part way, or its service activation failed. The rollback calls the fence synchronously
  // right before each rename, and the fence admits only trees this install owns (renames keep
  // identity): its validated candidate, the copy that was live when the updater registered the
  // transaction (before any live change), that copy as the backup, or none while moved aside.
  type Identity = { dev: bigint; ino: bigint };
  let original: Identity | undefined;
  let replacedByAnotherInstall = false;
  const identityOf = (entry: string): Identity | undefined => {
    const stat = fsSync.lstatSync(entry, { bigint: true, throwIfNoEntry: false });
    return stat ? { dev: stat.dev, ino: stat.ino } : undefined;
  };
  const sameIdentity = (a: Identity | undefined, b: Identity | undefined) =>
    a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
  // The swap reads its rollback baseline right after validateCandidate and before the activation
  // gate, where this install can wait on its service install while another update publishes or
  // rolls back. Replacing that copy would back up a copy the rollback cannot verify against its
  // baseline, so the gate refuses when the live copy is no longer the one seen at validation.
  // A publish in the few awaits after validation or after the gate check is not covered.
  let baseline: Identity | undefined;
  // The swap renames this validated candidate into place, so its identity is the published
  // copy's. It is read here, never from the live path after the updater returns.
  let candidate: Identity | undefined;
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
      candidate = identityOf(candidateRoot);
      baseline = identityOf(replacement.packageRoot);
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
      const live = identityOf(replacement.packageRoot);
      if (live === undefined ? baseline !== undefined : !sameIdentity(live, baseline)) {
        throw new Error(
          `The durable OpenClaw copy at ${replacement.packageRoot} changed while this install waited to replace it, probably by another update; nothing was replaced. Rerun the install to replace it with OpenClaw ${replacement.version}.`,
        );
      }
    },
    // A retained transaction keeps the previous copy until settle restores or retires it.
    onTransaction: (registered) => {
      transaction = registered;
      original = identityOf(replacement.packageRoot);
    },
  });
  const outcome = await Promise.race([prepared.promise.then(() => null), completed]);
  if (outcome) {
    throw failure(outcome.failedStep ?? { name: "the package update stopped before activation" });
  }
  // Service installs have no update-run fence; the package lock orders them among themselves.
  const unfenced = () => undefined;
  const restoreAuthority = (owned: Array<Identity | undefined>) => () => {
    const live = identityOf(replacement.packageRoot);
    if (live && !owned.some((identity) => sameIdentity(live, identity))) {
      replacedByAnotherInstall = true;
      throw new Error(
        `The durable OpenClaw copy at ${replacement.packageRoot} was replaced by another install before this failed install could restore it; keeping the current copy.`,
      );
    }
  };
  return {
    /** Whether the updater registered a transaction, i.e. started changing the live copy. */
    published: () => transaction !== undefined,
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
        // The transaction keeps this authority for the rest of its restore and retirement.
        const authority = restoreAuthority([
          candidate,
          original,
          identityOf(transaction.backupRoot),
        ]);
        const restored = await transaction.rollback(authority).catch((error: unknown) => {
          if (!replacedByAnotherInstall) {
            throw error;
          }
          return undefined;
        });
        if (replacedByAnotherInstall) {
          // The other owner's copy stays live; this install's backup stays for inspection.
          warnings.push(
            `The durable OpenClaw copy at ${replacement.packageRoot} was replaced by another install before this failed install could restore it; keeping the current copy and the previous copy's backup at ${transaction.backupRoot}.`,
          );
          return warnings;
        }
        if (restored && restored.exitCode !== 0) {
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
