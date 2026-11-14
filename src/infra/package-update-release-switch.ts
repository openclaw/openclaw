import fs from "node:fs/promises";
import path from "node:path";
import { ignoreMissingPath } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { collectPackageReleases } from "./package-release-retention.js";
import { packageReleaseGlobalRoot } from "./package-release-slot-path.js";
import {
  adoptPackageReleaseSlot,
  assertPackageReleaseIdentity,
  assertPackageReleaseLaunchers,
  capturePackageReleaseSlot,
  createPackageReleasePrefix,
  packageReleaseLinkTarget,
  readPackageReleaseIdentity,
  switchPackageReleaseLink,
  type PackageReleaseIdentity,
} from "./package-release-slot.js";
import { removePackageUpdatePath } from "./package-update-filesystem.js";
import { preparePackageSwapLocalOverrides } from "./package-update-local-overrides.js";
import {
  PackageUpdateActivationError,
  type PackageUpdateTransaction,
  type StagedPackageSwapParams,
  type StagedPackageSwapResult,
} from "./package-update-swap-contract.js";
import { createPackageSwapResults } from "./package-update-swap-results.js";
import { retireVerifiedPackageSwap } from "./package-update-swap-retirement.js";
import { runPackagePostInstallVerification } from "./package-update-verification-step.js";
import { UpdateRunPackageReleaseSchema } from "./update-run-schema.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import type { UpdateStepResult } from "./update-step-result.js";
import { SystemPackageOwnershipError } from "./update-system-package-ownership.js";

/**
 * Activates a staged release by repointing the package link. The previous
 * release is never written, so rollback points the link back after checking the
 * previous release against its recorded identity. A plain package directory is
 * first adopted as the previous release.
 */
export async function switchStagedPackageRelease(
  params: StagedPackageSwapParams,
): Promise<StagedPackageSwapResult> {
  const startedAt = Date.now();
  const release = params.stage.release;
  if (!release) {
    throw new Error("A release switch requires a release stage.");
  }
  const { slot } = release;
  const globalRoot = path.dirname(slot);
  const results = createPackageSwapResults(params, { globalRoot }, slot, startedAt);
  const { warnings, step } = results;
  const assertCurrent = () => params.assertCurrent?.();
  const candidateRoot = params.stage.packageRoot;
  let adoptionPrefix: string | undefined;
  let previous: PackageReleaseIdentity | undefined;
  let selectedLink: { identity: string; target: string } | undefined;
  let activated = false;
  let retained = false;
  let mutationStarted = false;
  let packageRollbackVerified = false;

  const candidateTarget = packageReleaseLinkTarget(slot, candidateRoot);
  // The link on disk decides: a switch can fail after its rename. Pointing it
  // back is refused when the previous release was rewritten or another writer
  // changed the link.
  const restorePrevious = async (assertion: () => void): Promise<string[]> => {
    try {
      const entry = await fs.lstat(slot, { bigint: true }).catch(ignoreMissingPath);
      const target = entry?.isSymbolicLink() ? await fs.readlink(slot) : null;
      await assertPackageReleaseIdentity(previous!);
      if (selectedLink && target !== selectedLink.target) {
        if (!entry || target !== candidateTarget) {
          throw new Error(
            `Package link ${slot} names ${target ?? "nothing"}, not this update's candidate; another writer changed it`,
          );
        }
        await switchPackageReleaseLink({
          slot,
          expected: { identity: `${entry.dev}:${entry.ino}`, target },
          target: selectedLink.target,
          assertCurrent: assertion,
        });
      }
      packageRollbackVerified = true;
      return [];
    } catch (error) {
      assertion();
      packageRollbackVerified = false;
      return [
        `${formatErrorMessage(error)}. Inspect ${slot} and the releases in ${path.join(release.prefix, "releases")} before restarting.`,
      ];
    }
  };

  try {
    assertCurrent();
    params.reserveInstallSlot?.(slot);
    // Nothing outside the release may change, so the launchers must already match.
    await assertPackageReleaseLaunchers(
      params.stage.layout.binDir,
      path.join(release.prefix, "bin"),
    );
    const captured = await capturePackageReleaseSlot(slot);
    const candidate = await readPackageReleaseIdentity(candidateRoot);
    if (captured.kind === "directory") {
      adoptionPrefix = await createPackageReleasePrefix(
        release.prefix,
        captured.release.version ?? "adopted",
      );
      await fs.mkdir(packageReleaseGlobalRoot(adoptionPrefix), { recursive: true });
    }
    // Where the previous release lives once it is a release; until adoption, the directory itself.
    const previousRoot = adoptionPrefix
      ? path.join(packageReleaseGlobalRoot(adoptionPrefix), path.basename(slot))
      : captured.release.path;
    previous = captured.release;
    const record = UpdateRunPackageReleaseSchema.parse({
      slot,
      from: { ...previous, path: previousRoot },
      to: candidate,
      ...(adoptionPrefix ? { adoption: true } : {}),
    });
    const replayLocalOverrides = await preparePackageSwapLocalOverrides({
      ...params,
      hadPackage: true,
      rootLinked: false,
      targetSwapRoot: params.installTarget.packageRoot ?? slot,
      backupRoot: previousRoot,
    });
    try {
      await params.beforeActivate?.();
    } catch (error) {
      throw new PackageUpdateActivationError(error);
    }
    // Record before the transaction captures the databases: a ledger write after
    // that capture would make database rollback refuse, and with it the link rollback.
    await params.onPackageRelease?.(record);
    if (params.onTransaction) {
      retained = true;
      await params.onTransaction(createTransaction());
    }
    assertCurrent();
    params.onLiveMutation?.();
    mutationStarted = true;
    if (captured.kind === "directory") {
      const adopted = await adoptPackageReleaseSlot({
        slot,
        releasePrefix: adoptionPrefix!,
        expected: captured,
        assertCurrent,
      });
      adoptionPrefix = undefined;
      previous = { ...previous, path: adopted.releaseRoot };
      selectedLink = adopted;
    } else {
      selectedLink = captured;
    }
    await replayLocalOverrides?.({ backupRoot: previousRoot, packageRoot: candidateRoot });
    // From here the link may name the candidate; stage cleanup must keep it.
    params.stage.activationCustody = true;
    await switchPackageReleaseLink({
      slot,
      expected: selectedLink,
      target: candidateTarget,
      assertCurrent,
      assertCandidate: () => assertPackageReleaseIdentity(candidate),
    });
    activated = true;
    const postVerifyStep = params.postVerifyStep
      ? await runPackagePostInstallVerification(slot, params.postVerifyStep)
      : null;
    if (postVerifyStep && isFailedUpdateStep(postVerifyStep) && !retained) {
      const messages = await restorePrevious(assertCurrent);
      return results.verificationFailed(slot, packageRollbackVerified, messages, postVerifyStep);
    }
    if (!retained) {
      warnings.push(...(await collect()));
    }
    return {
      status: "committed",
      activePackageRoot: slot,
      step: step(
        0,
        `switched ${params.packageName} to release ${path.basename(params.stage.prefix)}; previous release retained at ${previousRoot}`,
        null,
      ),
      postVerifyStep,
    };
  } catch (error) {
    if (adoptionPrefix && !mutationStarted) {
      // Allocated for adoption but never used: no package was moved into it.
      await removePackageUpdatePath(adoptionPrefix);
    }
    if (
      error instanceof PackageUpdateActivationError ||
      error instanceof SystemPackageOwnershipError
    ) {
      throw error instanceof PackageUpdateActivationError
        ? error
        : new PackageUpdateActivationError(error);
    }
    const errors = [results.rollbackError(error)];
    if (mutationStarted && !retained) {
      errors.push(...(await restorePrevious(assertCurrent)));
    }
    return results.failed(slot, error, errors, retained ? false : packageRollbackVerified);
  }

  async function collect(): Promise<string[]> {
    try {
      const outcome = await collectPackageReleases({
        slot,
        prefix: release!.prefix,
        keep: [previous!.path, candidateRoot],
      });
      return outcome.warnings;
    } catch (error) {
      return [`Release collection was skipped: ${formatErrorMessage(error)}`];
    }
  }

  function createTransaction(): PackageUpdateTransaction {
    let rollbackResult: ReturnType<PackageUpdateTransaction["rollback"]> | undefined;
    let retirement: Promise<UpdateStepResult | void> | undefined;
    let retainedAssertion: (() => void) | undefined;
    const retainAuthority = (assertion: () => void) => {
      retainedAssertion ??= assertion;
      retainedAssertion();
      return retainedAssertion;
    };
    const transaction: PackageUpdateTransaction = {
      // Database captures sit beside the package path; no package is backed up.
      backupRoot: path.join(globalRoot, `.openclaw.package-backup-${process.pid}-${Date.now()}`),
      assertRollbackSafe: () => assertPackageReleaseIdentity(previous!),
      rollback: (assertion) => {
        const assertRollbackCurrent = retainAuthority(assertion);
        if (retirement) {
          return Promise.resolve({
            ...step(
              1,
              null,
              "Package transaction retirement has started; automatic rollback is no longer available.",
            ),
            name: "package-rollback",
            activePackageRoot: slot,
          });
        }
        rollbackResult ??= (async () => {
          const rollbackStartedAt = Date.now();
          const messages = await restorePrevious(assertRollbackCurrent);
          return {
            ...step(
              packageRollbackVerified ? 0 : 1,
              packageRollbackVerified
                ? `restored the previous ${params.packageName} release ${previous!.path}`
                : null,
              messages.join("\n") || null,
            ),
            name: "package-rollback",
            activePackageRoot: slot,
            command: `link ${slot} -> ${previous!.path}`,
            durationMs: Date.now() - rollbackStartedAt,
          };
        })();
        return rollbackResult;
      },
      complete: async ({ activationVerified }, assertion) => {
        const assertCompleteCurrent = retainAuthority(assertion);
        if (retirement) {
          return await retirement;
        }
        const outcomeVerified = rollbackResult
          ? (await rollbackResult).exitCode === 0 && packageRollbackVerified
          : activated && activationVerified;
        assertCompleteCurrent();
        if (!outcomeVerified) {
          return {
            ...step(
              1,
              null,
              `Installation recovery is unverified; inspect ${slot} and the releases in ${path.join(release!.prefix, "releases")} before restarting.`,
            ),
            name: "package-backup-retention",
          };
        }
        retirement ??= (async () => {
          const retired = await retireVerifiedPackageSwap({
            activation: undefined,
            rootLink: undefined,
            hadPackage: false,
            previousRoot: undefined,
            backupRoot: transaction.backupRoot,
            databaseBackupRoot: rollbackResult ? undefined : transaction.databaseBackupRoot,
            discardDatabaseCaptures: transaction.discardDatabaseCaptures,
            launchers: { entries: [] },
            packageBackedUp: false,
            globalRoot,
            assertCurrent: assertCompleteCurrent,
            step,
          });
          const collection = rollbackResult ? [] : await collect();
          if (!collection.length) {
            return retired;
          }
          const message = [retired?.stderrTail, ...collection].filter(Boolean).join("\n");
          return {
            ...step(1, null, message),
            name: "package-backup-retention",
            advisory: { kind: "recoverable-maintenance" as const, message },
          };
        })();
        return await retirement;
      },
    };
    transaction.databaseBackupRoot = transaction.backupRoot;
    return transaction;
  }
}
