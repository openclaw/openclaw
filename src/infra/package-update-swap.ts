import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { formatErrorMessage, isErrno } from "./errors.js";
import {
  collectPackageDistInventory,
  readPackageDistInventoryIfPresent,
} from "./package-dist-inventory.js";
import {
  activateStagedNpmPackageRoot,
  capturePackageLaunchers,
  type PackageLauncherBackup,
  discardPackageLauncherBackup,
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
  PackageIntegrityTimeoutError,
  readPackageVersionIfPresent,
  type PackageDirectoryIdentity,
  type PackageRootIntegrityFingerprint,
} from "./package-update-integrity.js";
import { preparePackageSwapLocalOverrides } from "./package-update-local-overrides.js";
import {
  createNpmPackageRootLinkLifecycle,
  verifyNpmRootRecovery,
} from "./package-update-npm-root.js";
import {
  PackageUpdateActivationError,
  type PackageUpdateTransaction,
  type StagedPackageSwapResult,
  type StagedPackageSwapParams,
} from "./package-update-swap-contract.js";
import { runPackagePostInstallVerification } from "./package-update-verification-step.js";
import { movePathWithCopyFallback } from "./replace-file.js";
import { createUpdateErrorFact, createUpdateFailureFact } from "./update-failure-facts.js";
import {
  createFreeBsdPkgOwnershipInspection,
  FreeBsdPkgOwnershipError,
} from "./update-freebsd-pkg-ownership.js";
import { verifyPackageUpdateRecovery } from "./update-global.js";
import {
  finalizeNativePackageStage,
  NativePackageRollbackError,
} from "./update-native-package-stage.js";
import { resolveNpmGlobalPrefixLayoutFromGlobalRoot } from "./update-npm-prefix.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";
import type { UpdateStepResult } from "./update-runner-types.js";

export { PackageUpdateActivationError } from "./package-update-swap-contract.js";
export type {
  PackageUpdateTransaction,
  StagedPackageInstall,
} from "./package-update-swap-contract.js";

export { removePackageUpdatePath } from "./package-update-filesystem.js";

export async function swapStagedPackageInstall(
  params: StagedPackageSwapParams,
): Promise<StagedPackageSwapResult> {
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
  const warnings: string[] = [];
  let baselineError: Error | undefined;
  const step = (
    exitCode: number,
    stdoutTail: string | null,
    stderrTail: string | null,
    code = "swap-failed",
  ): UpdateStepResult => ({
    name: "package-swap",
    command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot ?? "unknown root"}`,
    cwd: targetLayout?.globalRoot ?? params.stage.prefix,
    durationMs: Date.now() - startedAt,
    exitCode,
    stdoutTail,
    stderrTail,
    ...(exitCode !== 0
      ? {
          failureFacts: [
            baselineError
              ? { ...createUpdateErrorFact("package-swap", baselineError), code }
              : createUpdateFailureFact({
                  check: "package-swap",
                  code,
                  message: stderrTail ?? undefined,
                }),
          ],
        }
      : {}),
    ...(exitCode === 0 && warnings.length > 0
      ? {
          advisory: {
            kind: "recoverable-maintenance" as const,
            message: warnings.join("\n"),
          },
          warnings: [...warnings],
        }
      : {}),
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
  const backupRoot = path.join(
    targetLayout.globalRoot,
    `.openclaw.package-backup-${process.pid}-${Date.now()}`,
  );
  let hadPackage = false;
  let replayLocalOverrides: (() => Promise<void>) | undefined;
  let previousVersion: string | null = null;
  let previousDistFiles: string[] | undefined;
  let previousRoot: PackageRootIntegrityFingerprint | undefined;
  let previousIdentity: PackageDirectoryIdentity | undefined;
  let rootLink: Awaited<ReturnType<typeof createNpmPackageRootLinkLifecycle>> | undefined;
  let packageBackedUp = false;
  let displacedCandidateRoot: string | undefined;
  const baseline = createPackageIntegrityReader(params.timeoutMs);
  const launchers: PackageLauncherBackup = { entries: [] };
  const shims = launchers.entries;
  const rollback: Array<(assertCurrent: () => void) => Promise<void>> = [];
  let packageRollbackVerified = false;
  let retained = false;
  let liveMutationStarted = false;
  let projectActivated = false;
  let activationCompleted = false;
  const assertReplacementUnowned = async () => {
    // A fresh observation, not an atomic lock against an external pkg writer.
    const inspection = createFreeBsdPkgOwnershipInspection(
      params.timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS,
    );
    await inspection.assertUnowned(targetSwapRoot);
    for (const shim of shims) {
      await inspection.assertEntryUnowned(shim.destination);
    }
  };
  const verifyNpmRecovery = (root: string, fromBackup: boolean) =>
    verifyNpmRootRecovery(
      { root, fromBackup, hadPackage, previousRoot, previousIdentity, targetSwapRoot, shims },
      params.timeoutMs,
      rootLink?.verifyRuntime,
    );
  const restoreSwap = async (assertCurrent = () => {}): Promise<string[]> => {
    assertCurrent();
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
    if (process.platform === "freebsd" && (packageBackedUp || rollback.length > 0)) {
      try {
        await assertReplacementUnowned();
        assertCurrent();
      } catch (error) {
        assertCurrent();
        packageRollbackVerified = false;
        return [
          `${formatErrorMessage(error)}; installation and backups retained for manual recovery`,
        ];
      }
    }
    for (const restore of native ? rollback.toReversed() : rollback) {
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
        packageRollbackVerified =
          (await verifyNpmRecovery(targetSwapRoot, false)) && messages.length === 0;
        if (packageRollbackVerified && !previousRoot) {
          warnings.push(
            "Package fingerprint verification unavailable; rollback verified by the retained package copy's directory identity and version.",
          );
        }
        if (previousRoot?.kind === "link" && !rootLink?.verifyRuntime && messages.length === 0) {
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
    } else {
      for (const [root, label] of [
        [launchers.backupDir, "shim backup"],
        [displacedCandidateRoot, "rejected update"],
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
      try {
        previousRoot = await baseline.rootEntry(targetSwapRoot);
      } catch (error) {
        // Preserve the scan cause if the identity fallback also fails.
        baselineError = new Error("Baseline package scan failed", { cause: error });
        if (!(error instanceof PackageIntegrityTimeoutError)) {
          throw error;
        }
        // Capture the identity before mutation even when the full walk exhausted its budget.
        previousIdentity =
          (await createPackageIntegrityReader(params.timeoutMs).directoryIdentity(
            targetSwapRoot,
          )) ?? undefined;
        if (!previousIdentity) {
          throw error;
        }
        warnings.push(
          `baseline package fingerprint incomplete after ${error.budgetMs / 1000} s; rollback will be verified by the retained package copy`,
        );
      }
      baselineError = undefined;
      previousVersion =
        previousRoot?.kind === "directory"
          ? previousRoot.tree.version
          : (previousIdentity?.version ?? null);
      if (previousRoot?.kind === "link") {
        rootLink = await createNpmPackageRootLinkLifecycle({
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
    replayLocalOverrides = await preparePackageSwapLocalOverrides({
      ...params,
      hadPackage,
      rootLinked: Boolean(rootLink),
      targetSwapRoot,
      backupRoot,
    });
    packageRollbackVerified = hadPackage && previousVersion !== null;
  };
  try {
    await (native ? readBaseline() : baseline.observe("baseline", readBaseline));
    // The optional tree scan must not consume the launcher backup's deadline.
    const launcherReader = createPackageIntegrityReader(params.timeoutMs);
    await launcherReader.observe("baseline", () =>
      capturePackageLaunchers(launchers, params, targetLayout, launcherReader),
    );
    // Validation and launcher backup finish while the old Gateway is serving.
    // Only this boundary authorizes the orchestrator to suspend the service.
    const assertProjectUnchanged = native
      ? await finalizeNativePackageStage(native, params.packageName)
      : undefined;
    if (process.platform === "freebsd") {
      await assertReplacementUnowned();
    }
    try {
      await params.beforeActivate?.();
    } catch (error) {
      throw new PackageUpdateActivationError(error);
    }
    if (native) {
      // Service preparation can wait for drain; revalidate the project copied before that wait.
      await native.assertUnchanged();
    }
    if (process.platform === "freebsd") {
      // Draining and project validation may outlive package ownership. Refuse
      // before registering a transaction or replacing any live entry.
      await assertReplacementUnowned();
      params.assertCurrent?.();
    }
    if (params.onTransaction) {
      retained = true;
      let retirement: Promise<UpdateStepResult | void> | undefined;
      let rollbackRefused = false;
      let rollbackResult: ReturnType<PackageUpdateTransaction["rollback"]> | undefined;
      let retainedAssertion: (() => void) | undefined;
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
        : rootLink?.verifyRuntime;
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
              name: "package-rollback",
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
                name: "package-rollback",
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
              name: "package-rollback",
              activePackageRoot,
              command: `restore ${backupRoot} -> ${targetSwapRoot}`,
              durationMs: Date.now() - rollbackStartedAt,
            };
          })();
          return rollbackResult;
        },
        complete: async ({ activationVerified }, assertion): Promise<UpdateStepResult | void> => {
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
              name: "package-backup-retention",
            };
          }
          // Seal automatic rollback once retirement begins, but retain the actual
          // outcome. A repeated completion must not report a renamed backup gone.
          retirement = (async () => {
            const messages: string[] = [];
            // The filesystem fallback can recheck an assertion after catching it.
            // A later successful read cannot turn that authority failure into cleanup.
            let assertionFailure: { cause: unknown } | undefined;
            const assertRetirementCurrent = () => {
              if (assertionFailure) {
                throw assertionFailure.cause;
              }
              try {
                assertCurrent();
              } catch (cause) {
                assertionFailure = { cause };
                throw cause;
              }
            };
            const linkRetention =
              rootLink && packageBackedUp ? await rootLink.retire(assertRetirementCurrent) : null;
            assertRetirementCurrent();
            if (linkRetention) {
              return { ...step(1, null, linkRetention), name: "package-backup-retention" };
            }
            if (hadPackage && previousRoot?.kind !== "link") {
              const message = await discardPackageUpdateBackup(
                backupRoot,
                "old package",
                targetLayout.globalRoot,
                assertRetirementCurrent,
              );
              if (message) {
                messages.push(message);
              }
            }
            const launcherCleanup = await discardPackageLauncherBackup(
              launchers,
              targetLayout.globalRoot,
              assertRetirementCurrent,
            );
            if (launcherCleanup) {
              messages.push(launcherCleanup);
            }
            // Capture authority loss during the final filesystem await in the
            // retirement outcome, not only in the caller's later publication check.
            assertRetirementCurrent();
            if (messages.length) {
              return {
                ...step(1, null, messages.join("\n")),
                name: "package-backup-retention",
                // Only this verified obsolete-resource path qualifies the warning.
                // Recovery refusal and unclassified link outcomes remain hard.
                advisory: {
                  kind: "recoverable-maintenance" as const,
                  message: `Installation verification succeeded; backup cleanup remains pending. ${messages.join("\n")}. Inspect retained paths before removing obsolete backups manually.`,
                },
              };
            }
            return undefined;
          })();
          return await retirement;
        },
      });
    }
    await rootLink?.assertLiveUnchanged();
    if (process.platform === "freebsd") {
      // Keep executor authority after the last asynchronous link observation.
      params.assertCurrent?.();
    }
    // A native refusal must still allow the unchanged Gateway to restart.
    // Mark mutation only now: a copy-fallback move can fail after partial publication,
    // and only a completed backup permits restoration.
    params.onLiveMutation?.();
    liveMutationStarted = true;
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
      packageRollbackVerified =
        native !== undefined ||
        previousRoot?.kind === "directory" ||
        previousIdentity !== undefined;
    }
    rollback.push(async (assertCurrent) => {
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
                `${formatErrorMessage(error)}; update retained at ${displacedCandidateRoot}`,
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
    });
    await replayLocalOverrides?.();
    await activateStagedNpmPackageRoot(stagedSwapRoot, targetSwapRoot);
    activePackageRoot = targetPackageRoot;
    projectActivated = true;
    for (const shim of shims) {
      // Register before copying: replacing an entry can fail after removing it.
      rollback.push(async (assertCurrent) => {
        if (shim.backup) {
          await copyPathEntry(shim.backup, shim.destination, assertCurrent);
        } else {
          await removePath(shim.destination, assertCurrent);
        }
      });
      await copyPathEntry(shim.source, shim.destination);
    }
    activationCompleted = true;
    const postVerifyStep = params.postVerifyStep
      ? await runPackagePostInstallVerification(targetPackageRoot, params.postVerifyStep)
      : null;
    if (postVerifyStep && isFailedUpdateStep(postVerifyStep) && !retained) {
      const rollbackMessages = await restoreSwap();
      return {
        status: "failed",
        activePackageRoot,
        step: packageRollbackVerified
          ? step(
              0,
              [
                `restored previous ${params.packageName} package and affected launchers after verification failed`,
                "Update Doctor may have changed persistent state; managed Gateway remains stopped",
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
    const cleanup = [
      hadPackage && !retained
        ? rootLink
          ? await rootLink.retire()
          : await discardPackageUpdateBackup(backupRoot, "old package", targetLayout.globalRoot)
        : null,
      !retained ? await discardPackageLauncherBackup(launchers, targetLayout.globalRoot) : null,
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
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    if (
      error instanceof PackageUpdateActivationError ||
      error instanceof FreeBsdPkgOwnershipError
    ) {
      await discardPackageLauncherBackup(launchers, targetLayout.globalRoot);
      throw error instanceof PackageUpdateActivationError
        ? error
        : new PackageUpdateActivationError(error);
    }
    const errors = [formatErrorMessage(baselineError ?? error)];
    if (!retained && !liveMutationStarted) {
      // Preparation can fail before a baseline exists. There is nothing to
      // restore; the caller independently verifies the untouched runtime.
      packageRollbackVerified = false;
      const cleanup = await discardPackageLauncherBackup(launchers, targetLayout.globalRoot);
      if (cleanup) {
        errors.push(cleanup);
      }
    } else if (!retained) {
      errors.push(...(await restoreSwap()));
    }
    return {
      status: "failed",
      activePackageRoot,
      step: step(
        1,
        null,
        errors.join("\n"),
        baselineError
          ? "baseline-scan-failed"
          : isErrno(error) && typeof error.code === "string"
            ? error.code
            : error instanceof Error
              ? error.name
              : "swap-failed",
      ),
      postVerifyStep: null,
      packageRollbackVerified: retained ? false : packageRollbackVerified,
    };
  }
}
