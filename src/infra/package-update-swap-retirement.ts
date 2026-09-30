import { retainMutationAuthority } from "./mutation-authority.js";
import {
  discardPackageUpdateBackup,
  discardPackageLauncherBackup,
  type PackageLauncherBackup,
} from "./package-update-filesystem.js";
import type { PackageRootIntegrityFingerprint } from "./package-update-integrity.js";
import type { createNpmPackageRootLinkLifecycle } from "./package-update-npm-root.js";
import { PackageUpdateActivationError } from "./package-update-swap-contract.js";
import { UPDATE_CLEANUP_BUDGET_MS } from "./update-maintenance.js";
import type { UpdateStepResult } from "./update-step-result.js";

/** Refusal occurred before transaction handoff or any live package mutation. */
export async function retireRefusedPackageSwap(
  activation: { disarmRollback: () => Promise<boolean>; retire: () => Promise<unknown> },
  refusal: unknown,
): Promise<void> {
  try {
    // The publication owner verifies the original live generation and launchers
    // before disarming forward recovery and removing its prepared candidate.
    await activation.disarmRollback();
    await activation.retire();
  } catch (retirementError) {
    throw new PackageUpdateActivationError(
      new AggregateError(
        [refusal, retirementError],
        "Package activation was refused and its prepared publication could not be retired.",
        { cause: refusal },
      ),
    );
  }
}

/** Called only by the verified, cached transaction completion path. */
export async function retireVerifiedPackageSwap(params: {
  activation: { retire: () => Promise<unknown> } | undefined;
  rootLink: Awaited<ReturnType<typeof createNpmPackageRootLinkLifecycle>> | undefined;
  hadPackage: boolean;
  previousRoot: PackageRootIntegrityFingerprint | undefined;
  backupRoot: string;
  databaseBackupRoot: string | undefined;
  launchers: PackageLauncherBackup;
  packageBackedUp: boolean;
  globalRoot: string;
  assertCurrent: () => void;
  step: (
    exitCode: number,
    stdoutTail: string | null,
    stderrTail: string | null,
  ) => UpdateStepResult;
}): Promise<UpdateStepResult | undefined> {
  const {
    activation,
    rootLink,
    hadPackage,
    previousRoot,
    backupRoot,
    launchers,
    packageBackedUp,
    assertCurrent,
    step,
  } = params;
  const messages: string[] = [];
  // The filesystem fallback can recheck an assertion after catching it.
  // A later successful read cannot turn that authority failure into cleanup.
  const assertRetirementCurrent = retainMutationAuthority(assertCurrent);
  const cleanupStartedAt = performance.now();
  const cleanupDeadlineAtMs = cleanupStartedAt + UPDATE_CLEANUP_BUDGET_MS;
  if (activation) {
    await activation.retire();
    // The anchor and helper are retired; only the executor fence remains.
    assertRetirementCurrent();
  } else {
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
        params.globalRoot,
        assertRetirementCurrent,
        cleanupDeadlineAtMs,
      );
      if (message) {
        messages.push(message);
      }
    }
    const launcherCleanup = await discardPackageLauncherBackup(
      launchers,
      params.globalRoot,
      assertRetirementCurrent,
      cleanupDeadlineAtMs,
    );
    if (launcherCleanup) {
      messages.push(launcherCleanup);
    }
  }
  // Verified activation ends automatic database restoration, so the snapshots
  // share the retired package backup's lifetime.
  if (params.databaseBackupRoot) {
    const message = await discardPackageUpdateBackup(
      `${params.databaseBackupRoot}.databases`,
      "pre-migration database snapshots",
      params.globalRoot,
      assertRetirementCurrent,
      cleanupDeadlineAtMs,
    );
    if (message) {
      messages.push(message);
    }
  }
  // Capture authority loss during the final filesystem await in the
  // retirement outcome, not only in the caller's later publication check.
  assertRetirementCurrent();
  if (messages.length) {
    return {
      ...step(1, null, messages.join("\n")),
      name: "package-backup-retention",
      durationMs: Math.round(performance.now() - cleanupStartedAt),
      // Only this verified obsolete-resource path qualifies the warning.
      // Recovery refusal and unclassified link outcomes remain hard.
      advisory: {
        kind: "recoverable-maintenance" as const,
        message: `Installation verification succeeded; backup cleanup remains pending. ${messages.join("\n")}. Inspect retained paths before removing obsolete backups manually.`,
      },
    };
  }
  return undefined;
}
