import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import {
  collectPackageDistInventory,
  readPackageDistInventoryIfPresent,
} from "./package-dist-inventory.js";
import {
  preparePackageActivation,
  type PackageActivationOptions,
} from "./package-update-activation.js";
import {
  activateStagedNpmPackageRoot,
  discardPackageUpdateBackup,
  copyPackagePathEntry as copyPathEntry,
  PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
  packagePathEntriesMatch as pathEntriesMatch,
  packagePathEntryExists as pathEntryExists,
  removePackagePath as removePath,
  restoreNpmPackageRoot,
} from "./package-update-filesystem.js";
import {
  createPackageIntegrityReader,
  readPackageVersionIfPresent,
  type PackageRootIntegrityFingerprint,
} from "./package-update-integrity.js";
import {
  createNpmPackageRootLinkLifecycle,
  verifyNpmRootRecovery,
} from "./package-update-npm-root.js";
import {
  PackageUpdateActivationError,
  type PackageUpdateTransaction,
  type StagedPackageInstall,
  type StagedPackageSwapResult,
} from "./package-update-swap-contract.js";
import { retireVerifiedPackageSwap } from "./package-update-swap-retirement.js";
import { movePathWithCopyFallback } from "./replace-file.js";
import {
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  verifyPackageUpdateRecovery,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";
import {
  finalizeNativePackageStage,
  NativePackageRollbackError,
} from "./update-native-package-stage.js";
import type { UpdateStepResult } from "./update-runner-types.js";

export { PackageUpdateActivationError } from "./package-update-swap-contract.js";
export type {
  PackageUpdateTransaction,
  StagedPackageInstall,
} from "./package-update-swap-contract.js";

export function isBlockingPackageUpdateStep(step: UpdateStepResult): boolean {
  return step.exitCode !== 0 && step.advisory === undefined;
}

export { removePackageUpdatePath } from "./package-update-filesystem.js";

export async function swapStagedPackageInstall(params: {
  stage: StagedPackageInstall;
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  postVerifyStep?: (packageRoot: string) => Promise<UpdateStepResult | null>;
  beforeActivate?: () => Promise<void>;
  onLiveMutation?: () => void;
  onTransaction?: (transaction: PackageUpdateTransaction) => void;
  timeoutMs?: number;
  activation?: PackageActivationOptions;
}): Promise<StagedPackageSwapResult> {
  const startedAt = Date.now();
  let activePackageRoot = params.installTarget.packageRoot;
  const native = params.stage.native;
  const targetLayout = native
    ? {
        prefix: native.liveProjectRoot,
        globalRoot: path.dirname(native.liveProjectRoot),
        binDir: native.liveBinDir,
      }
    : resolveNpmGlobalPrefixLayoutFromGlobalRoot(params.installTarget.globalRoot, {
        allowDirectNodeModulesRoot: params.installTarget.directNodeModulesRoot === true,
      });
  const targetPackageRoot = native
    ? path.join(native.liveProjectRoot, path.relative(native.projectRoot, params.stage.packageRoot))
    : params.installTarget.packageRoot;
  const targetSwapRoot = native?.liveProjectRoot ?? targetPackageRoot;
  const stagedSwapRoot = native?.projectRoot ?? params.stage.packageRoot;
  let activationUnavailable: string | undefined;
  const step = (
    exitCode: number,
    stdoutTail: string | null,
    stderrTail: string | null,
  ): UpdateStepResult => ({
    name: "global install swap",
    command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot ?? "unknown root"}`,
    cwd: targetLayout?.globalRoot ?? params.stage.prefix,
    durationMs: Date.now() - startedAt,
    exitCode,
    stdoutTail,
    stderrTail: [stderrTail, activationUnavailable].filter(Boolean).join("\n") || null,
  });
  if (!targetLayout || !targetPackageRoot || !targetSwapRoot) {
    return {
      status: "failed",
      activePackageRoot,
      step: step(1, null, "cannot resolve npm global prefix layout"),
      postVerifyStep: null,
      packageRollbackVerified: false,
    };
  }

  // Recovery artifacts must survive cleanupGlobalRenameDirs on a later update.
  let backupRoot = path.join(
    targetLayout.globalRoot,
    `.openclaw.package-backup-${process.pid}-${Date.now()}`,
  );
  let shimBackupDir: string | undefined;
  let hadPackage = false;
  let previousVersion: string | null = null;
  let previousDistFiles: string[] | undefined;
  let previousRoot: PackageRootIntegrityFingerprint | undefined;
  let rootLink: ReturnType<typeof createNpmPackageRootLinkLifecycle> | undefined;
  let packageBackedUp = false;
  let displacedCandidateRoot: string | undefined;
  const baseline = createPackageIntegrityReader(params.timeoutMs);
  const shims: Array<{
    source: string;
    destination: string;
    backup: string | null;
    fingerprint?: string;
  }> = [];
  const rollback: Array<(assertCurrent: () => void) => Promise<void>> = [];
  let packageRollbackVerified = false;
  let retained = false;
  let projectActivated = false;
  let activationCompleted = false;
  let activation: Awaited<ReturnType<typeof preparePackageActivation>> | undefined;
  const verifyNpmRecovery = (root: string, fromBackup: boolean) =>
    verifyNpmRootRecovery(
      { root, fromBackup, hadPackage, previousRoot, targetSwapRoot, shims },
      params.timeoutMs,
    );
  const restoreSwap = async (executorAssertion = () => {}): Promise<string[]> => {
    const assertCurrent = () => {
      executorAssertion();
      activation?.assertCurrent();
    };
    assertCurrent();
    if (activation) {
      packageBackedUp = await activation.disarmRollback();
    }
    const messages: string[] = [];
    if (!native && (packageBackedUp || (!hadPackage && rollback.length > 0))) {
      try {
        // Refuse known-bad recovery material before touching the candidate or
        // its launchers, including launchers from a package-absent baseline.
        // This observation does not exclude concurrent writers.
        await verifyNpmRecovery(backupRoot, true);
      } catch (error) {
        assertCurrent();
        packageRollbackVerified = false;
        return [
          `${formatErrorMessage(error)}; current package unchanged; recovery evidence retained in ${targetLayout.globalRoot}`,
        ];
      }
    }
    for (const restore of activation && !packageBackedUp
      ? []
      : native
        ? rollback.toReversed()
        : rollback) {
      try {
        assertCurrent();
        await restore(assertCurrent);
        assertCurrent();
      } catch (restoreError) {
        // Ownership loss stops all compensation, including partial activation.
        // It is not an ordinary restore failure that permits the next launcher.
        assertCurrent();
        packageRollbackVerified = false;
        messages.push(`rollback failed: ${formatErrorMessage(restoreError)}`);
        // Keep a fully activated candidate's launchers on package refusal.
        // A partial activation still needs its registered shim compensation.
        if (!native && restore === rollback[0] && activationCompleted) {
          break;
        }
      }
    }
    if (native && rollback.length === 0 && hadPackage && previousVersion) {
      // Copy cleanup can remove the inventory before failing on a runtime file.
      // Verify against the pre-move file list, including for older packages.
      const original = await verifyPackageUpdateRecovery(params.installTarget.packageRoot);
      packageRollbackVerified =
        original.serviceRestartSafe &&
        original.version === previousVersion &&
        previousDistFiles !== undefined &&
        isDeepStrictEqual(
          await collectPackageDistInventory(params.installTarget.packageRoot!).catch(() => null),
          previousDistFiles,
        );
      if (packageRollbackVerified) {
        activePackageRoot = params.installTarget.packageRoot;
      }
    }
    if (!native) {
      try {
        await verifyNpmRecovery(targetSwapRoot, false);
        // Returning to absence cannot establish a verified previous runtime.
        packageRollbackVerified =
          hadPackage && previousRoot?.kind === "directory" && messages.length === 0;
        if (previousRoot?.kind === "link" && messages.length === 0) {
          messages.push(
            `${rollback.length > 0 ? "Restored" : "Verified"} the npm package link and affected launchers; external checkout runtime integrity is unverified.`,
          );
        }
      } catch (error) {
        assertCurrent();
        packageRollbackVerified = false;
        messages.push(formatErrorMessage(error));
      }
    }
    if (native) {
      const restoredVersion = await readPackageVersionIfPresent(params.installTarget.packageRoot);
      if (!hadPackage || !previousVersion || restoredVersion !== previousVersion) {
        packageRollbackVerified = false;
        messages.push(
          `rollback verification failed: expected package version ${previousVersion ?? "<none>"}, found ${restoredVersion ?? "<none>"}`,
        );
      }
    }
    for (const shim of native ? shims : []) {
      try {
        const restored = shim.backup
          ? await pathEntriesMatch(shim.backup, shim.destination)
          : !(await pathEntryExists(shim.destination));
        if (!restored) {
          packageRollbackVerified = false;
          messages.push(
            `rollback verification failed: launcher ${shim.destination} was not restored`,
          );
        }
      } catch (verificationError) {
        assertCurrent();
        packageRollbackVerified = false;
        messages.push(
          `rollback verification failed for launcher ${shim.destination}: ${formatErrorMessage(verificationError)}`,
        );
      }
    }
    if (!packageRollbackVerified) {
      messages.push(
        `Installation recovery is unverified; inspect the installation and backups in ${targetLayout.globalRoot} before restarting.`,
      );
    } else if (activation) {
      activation.restored();
    } else {
      for (const [root, label] of [
        [shimBackupDir, "shim backup"],
        [displacedCandidateRoot, "rejected candidate"],
      ] as const) {
        if (root) {
          const cleanup = await discardPackageUpdateBackup(
            root,
            label,
            targetLayout.globalRoot,
            assertCurrent,
          );
          if (cleanup) {
            messages.push(cleanup);
          }
        }
      }
    }
    assertCurrent();
    return messages;
  };
  const readBaseline = async () => {
    hadPackage = await (native ? pathEntryExists(targetSwapRoot) : baseline.exists(targetSwapRoot));
    previousVersion =
      hadPackage && native
        ? await readPackageVersionIfPresent(params.installTarget.packageRoot)
        : null;
    if (hadPackage && !native) {
      // Unreadable or unbounded rollback material must fail while the old
      // package is still live, before beforeActivate may stop its service.
      previousRoot = await baseline.rootEntry(targetSwapRoot);
      previousVersion = previousRoot.kind === "directory" ? previousRoot.tree.version : null;
      if (previousRoot.kind === "link") {
        rootLink = createNpmPackageRootLinkLifecycle({
          liveRoot: targetSwapRoot,
          backupRoot,
          fingerprint: previousRoot,
          timeoutMs: params.timeoutMs,
        });
      }
    }
    if (hadPackage && previousVersion && native) {
      previousDistFiles =
        (await readPackageDistInventoryIfPresent(params.installTarget.packageRoot!)) ??
        (await collectPackageDistInventory(params.installTarget.packageRoot!));
    }
    packageRollbackVerified = hadPackage && previousVersion !== null;
    await fs.mkdir(targetLayout.globalRoot, { recursive: true });
    const shimNames = new Set([params.packageName, "openclaw"]);
    const shimEntries =
      params.installTarget.directNodeModulesRoot === true
        ? []
        : (
            await (
              native
                ? fs.readdir(params.stage.layout.binDir)
                : baseline.entries(params.stage.layout.binDir)
            ).catch((error: unknown) => {
              if (hasErrnoCode(error, "ENOENT")) {
                return [];
              }
              throw error;
            })
          )
            .filter((entry) => shimNames.has(entry) || shimNames.has(path.parse(entry).name))
            .toSorted();
    if (shimEntries.length > 0) {
      shimBackupDir = await fs.mkdtemp(
        path.join(targetLayout.globalRoot, ".openclaw.shim-backup-"),
      );
      await fs.mkdir(targetLayout.binDir, { recursive: true });
      // Capture every original before moving its package; relative npm shims can
      // become dangling during the swap, and failed backup copies touch no live entry.
      for (const entry of shimEntries) {
        const destination = path.join(targetLayout.binDir, entry);
        const backup = (await (native
          ? pathEntryExists(destination)
          : baseline.exists(destination)))
          ? path.join(shimBackupDir, entry)
          : null;
        const fingerprint = backup && !native ? await baseline.launcher(destination) : undefined;
        if (backup) {
          await copyPathEntry(destination, backup);
          if (!native && (await baseline.launcher(backup)) !== fingerprint) {
            throw new Error(`Package rollback launcher backup changed: ${destination}`);
          }
        }
        shims.push({
          source: path.join(params.stage.layout.binDir, entry),
          destination,
          backup,
          fingerprint,
        });
      }
    }
  };
  try {
    await (native ? readBaseline() : baseline.observe("baseline", readBaseline));
    if (params.activation && previousRoot?.kind === "directory") {
      activation = await preparePackageActivation({
        installTarget: params.installTarget,
        options: {
          ...params.activation,
          onUnavailable: (message) => {
            activationUnavailable = message;
            params.activation?.onUnavailable?.(message);
          },
        },
        liveRoot: targetSwapRoot,
        stageRoot: stagedSwapRoot,
        launcherRoot: params.stage.layout.binDir,
        binDir: targetLayout.binDir,
        previous: previousRoot.tree,
        previousLauncherRoot: shimBackupDir,
        launchers: shims.map((shim) => ({
          name: path.basename(shim.destination),
          previous: shim.fingerprint ?? null,
        })),
      });
      if (activation) {
        backupRoot = path.join(activation.anchor, "previous");
        shimBackupDir = shimBackupDir && path.join(activation.anchor, "previous-launchers");
        for (const shim of shims) {
          shim.source = path.join(activation.anchor, "launchers", path.basename(shim.destination));
          if (shim.backup) {
            shim.backup = path.join(shimBackupDir!, path.basename(shim.destination));
          }
        }
      }
    }
    // Validation and launcher backup finish while the old Gateway is serving.
    // Only this boundary authorizes the orchestrator to suspend the service.
    const assertProjectUnchanged = native
      ? await finalizeNativePackageStage(native, params.packageName)
      : undefined;
    try {
      await params.beforeActivate?.();
    } catch (error) {
      throw new PackageUpdateActivationError(error);
    }
    if (native) {
      // Service preparation can wait for drain; revalidate the project copied before that wait.
      await native.assertUnchanged();
    }
    if (params.onTransaction) {
      retained = true;
      let retirement: Promise<UpdateStepResult | undefined> | undefined;
      let rollbackRefused = false;
      let rollbackResult: ReturnType<PackageUpdateTransaction["rollback"]> | undefined;
      let retainedAssertion: (() => void) | undefined = params.activation?.fence.assertCurrent;
      const retainAuthority = (assertCurrent: () => void) => {
        // Replays and completion keep the first executor. A later caller cannot
        // re-admit a transaction whose original owner has been revoked.
        retainedAssertion ??= assertCurrent;
        retainedAssertion();
        return retainedAssertion;
      };
      const assertRollbackSafe = assertProjectUnchanged
        ? async () => {
            if (!projectActivated) {
              return;
            }
            try {
              await assertProjectUnchanged();
            } catch (error) {
              rollbackRefused = true;
              throw error;
            }
          }
        : undefined;
      params.onTransaction({
        backupRoot,
        ...(assertRollbackSafe ? { assertRollbackSafe } : {}),
        rollback: (assertion) => {
          const assertCurrent = retainAuthority(assertion);
          if (retirement) {
            return Promise.resolve({
              ...step(
                1,
                null,
                "Package transaction retirement has started; automatic rollback is no longer available.",
              ),
              name: "global install rollback",
              activePackageRoot,
            });
          }
          // Repeated completion paths must never remove an already-restored package.
          rollbackResult ??= (async () => {
            const rollbackStartedAt = Date.now();
            // Late verification can outlive another global install. Check before
            // restoring any launcher or project bytes, or we'd erase sibling changes.
            try {
              await assertRollbackSafe?.();
            } catch (error) {
              assertCurrent();
              return {
                ...step(1, null, formatErrorMessage(error)),
                name: "global install rollback",
                activePackageRoot,
                ...(error instanceof NativePackageRollbackError ? { reason: error.reason } : {}),
              };
            }
            const messages = await restoreSwap(assertCurrent);
            return {
              ...step(
                packageRollbackVerified ? 0 : 1,
                packageRollbackVerified
                  ? `restored previous ${params.packageName} package and affected launchers`
                  : null,
                messages.join("\n") || null,
              ),
              name: "global install rollback",
              activePackageRoot,
              command: `restore ${backupRoot} -> ${targetSwapRoot}`,
              durationMs: Date.now() - rollbackStartedAt,
            };
          })();
          return rollbackResult;
        },
        complete: async (
          { activationVerified },
          assertion,
        ): Promise<UpdateStepResult | undefined> => {
          const assertCurrent = retainAuthority(assertion);
          if (retirement) {
            return await retirement;
          }
          // Retire backups only after verified activation or restoration. A failed
          // backup move can leave its published copy as the only intact installation.
          const outcomeVerified = rollbackResult
            ? (await rollbackResult).exitCode === 0 && packageRollbackVerified
            : (native ? projectActivated : activationCompleted) && activationVerified;
          assertCurrent();
          if (rollbackRefused || !outcomeVerified) {
            return {
              ...step(
                1,
                null,
                `Installation recovery is unverified; inspect the installation and backups in ${targetLayout.globalRoot} before restarting.`,
              ),
              name: "global install backup retention",
            };
          }
          // Seal automatic rollback once retirement begins, but retain the actual
          // outcome. A repeated completion must not report a renamed backup gone.
          // Recheck after rollback's await so concurrent completion shares this promise.
          retirement ??= retireVerifiedPackageSwap({
            activation,
            rootLink,
            hadPackage,
            previousRoot,
            backupRoot,
            shimBackupDir,
            globalRoot: targetLayout.globalRoot,
            assertCurrent,
            step,
          });
          return await retirement;
        },
      });
    }
    const restorePackage = async (assertCurrent: () => void) => {
      if (!native && hadPackage) {
        // Retain the candidate until the exact old object is restored. A
        // denied/cross-device rename must not silently copy or strand it.
        const candidatePresent = await pathEntryExists(targetSwapRoot);
        const displaced = `${backupRoot}.candidate`;
        activePackageRoot = null;
        try {
          await restoreNpmPackageRoot({
            liveRoot: targetSwapRoot,
            backupRoot,
            displacedRoot: displaced,
            candidatePresent,
            assertCurrent,
          });
          displacedCandidateRoot = candidatePresent ? displaced : undefined;
          packageBackedUp = false;
          activePackageRoot = params.installTarget.packageRoot;
        } catch (error) {
          assertCurrent();
          if (candidatePresent) {
            displacedCandidateRoot = (await pathEntryExists(displaced)) ? displaced : undefined;
            activePackageRoot = (await pathEntryExists(targetSwapRoot)) ? targetPackageRoot : null;
            if (displacedCandidateRoot) {
              throw new Error(
                `${formatErrorMessage(error)}; candidate retained at ${displacedCandidateRoot}`,
                { cause: error },
              );
            }
          }
          throw error;
        }
        return;
      }
      activePackageRoot = null;
      await removePath(targetSwapRoot, assertCurrent);
      if (hadPackage) {
        await movePathWithCopyFallback({
          from: backupRoot,
          sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
          to: targetSwapRoot,
          assertBeforeRename: assertCurrent,
          assertBeforeMutation: assertCurrent,
          onDestinationPublished: assertCurrent,
        });
        activePackageRoot = params.installTarget.packageRoot;
      }
    };
    const restoreShim = (shim: (typeof shims)[number]) => async (assertCurrent: () => void) => {
      if (shim.backup) {
        await copyPathEntry(
          shim.backup,
          shim.destination,
          assertCurrent,
          activation?.recordRestoredLauncher.bind(activation, path.basename(shim.destination)),
        );
      } else {
        await removePath(shim.destination, assertCurrent);
      }
    };
    if (activation) {
      rollback.push(restorePackage, ...shims.map(restoreShim));
      params.onLiveMutation?.();
      await activation.publish(false, () => {
        packageBackedUp = true;
        activePackageRoot = null;
      });
      activePackageRoot = targetPackageRoot;
      projectActivated = true;
      activationCompleted = true;
    } else {
      await rootLink?.assertLiveUnchanged();
      // A native refusal must still allow the unchanged Gateway to restart.
      // Mark mutation only now: a copy-fallback move can fail after partial publication,
      // and only a completed backup permits restoration.
      params.onLiveMutation?.();
      packageRollbackVerified = false;
      if (native || !hadPackage) {
        activePackageRoot = null;
      }
      if (hadPackage) {
        if (native) {
          await movePathWithCopyFallback({
            from: targetSwapRoot,
            sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
            to: backupRoot,
          });
        } else if (rootLink) {
          const acquisition = await rootLink.acquire();
          if (!acquisition.acquired) {
            activePackageRoot = null;
            throw new Error(acquisition.error);
          }
        } else {
          await fs.rename(targetSwapRoot, backupRoot);
        }
        activePackageRoot = null;
        packageBackedUp = true;
        packageRollbackVerified = native !== undefined || previousRoot?.kind === "directory";
      }
      rollback.push(restorePackage);
      await activateStagedNpmPackageRoot(stagedSwapRoot, targetSwapRoot);
      activePackageRoot = targetPackageRoot;
      projectActivated = true;
      for (const shim of shims) {
        // Register before copying: replacing an entry can fail after removing it.
        rollback.push(restoreShim(shim));
        await copyPathEntry(shim.source, shim.destination);
      }
      activationCompleted = true;
    }
    let postVerifyStep: UpdateStepResult | null = null;
    if (params.postVerifyStep) {
      try {
        postVerifyStep = await params.postVerifyStep(targetPackageRoot);
      } catch (error) {
        postVerifyStep = {
          name: "post-install verification",
          command: "verify installed package",
          cwd: targetPackageRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: formatErrorMessage(error),
        };
      }
      postVerifyStep ??= {
        name: "post-install verification",
        command: "verify installed package",
        cwd: targetPackageRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail:
          "Required post-install verification did not produce a result; Gateway activation is unsafe.",
      };
    }
    if (postVerifyStep && isBlockingPackageUpdateStep(postVerifyStep) && !retained) {
      const rollbackMessages = await restoreSwap();
      return {
        status: "failed",
        activePackageRoot,
        step: packageRollbackVerified
          ? step(
              0,
              [
                `restored previous ${params.packageName} package and affected launchers after verification failed`,
                "candidate Doctor may have changed persistent state; managed Gateway remains stopped",
                ...rollbackMessages,
              ]
                .filter(Boolean)
                .join("; "),
              null,
            )
          : step(1, null, rollbackMessages.join("\n")),
        postVerifyStep,
        packageRollbackVerified,
      };
    }
    if (activation && !retained) {
      await activation.retire();
    }
    const cleanup = activation
      ? []
      : [
          hadPackage && !retained
            ? rootLink
              ? await rootLink.retire()
              : await discardPackageUpdateBackup(backupRoot, "old package", targetLayout.globalRoot)
            : null,
          shimBackupDir && !retained
            ? await discardPackageUpdateBackup(
                shimBackupDir,
                "shim backup",
                targetLayout.globalRoot,
              )
            : null,
        ];
    return {
      status: "committed",
      activePackageRoot,
      step: step(
        0,
        [
          hadPackage ? `replaced ${params.packageName}` : `installed ${params.packageName}`,
          ...cleanup,
        ]
          .filter(Boolean)
          .join("; "),
        null,
      ),
      postVerifyStep,
    };
  } catch (error) {
    if (error instanceof PackageUpdateActivationError) {
      if (shimBackupDir && !activation) {
        await discardPackageUpdateBackup(shimBackupDir, "shim backup", targetLayout.globalRoot);
      }
      throw error;
    }
    const errors = [formatErrorMessage(error), ...(retained ? [] : await restoreSwap())];
    return {
      status: "failed",
      activePackageRoot,
      step: step(1, null, errors.join("\n")),
      postVerifyStep: null,
      packageRollbackVerified: retained ? false : packageRollbackVerified,
    };
  }
}
