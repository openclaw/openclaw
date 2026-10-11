import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "./errors.js";
import { retainMutationAuthority } from "./mutation-authority.js";
import { isLegacyPackageBackupName } from "./package-update-backup-paths.js";
import {
  assertPackagePathIdentity,
  discardPackageUpdateBackup,
  discardPackageLauncherBackup,
  type PackageLauncherBackup,
} from "./package-update-filesystem.js";
import type { PackageRootIntegrityFingerprint } from "./package-update-integrity.js";
import type { createNpmPackageRootLinkLifecycle } from "./package-update-npm-root.js";
import type { createPublicationOwner } from "./package-update-publication-owner.js";
import { PackageUpdateActivationError } from "./package-update-swap-contract.js";
import { UPDATE_CLEANUP_BUDGET_MS } from "./update-maintenance.js";
import type { UpdateStepResult } from "./update-step-result.js";
import {
  createSystemPackageOwnershipInspection,
  SystemPackageOwnershipError,
  PKG_INSPECTION_TIMEOUT_MS,
} from "./update-system-package-ownership.js";

type RetireLegacyPackageBackups = (
  assertCurrent: () => void,
  cleanupDeadlineAtMs: number,
) => Promise<string[]>;

/** Later verified activation may retire only the historical objects observed before this swap. */
export async function captureLegacyPackageBackupRetirement(
  globalRoot: string,
  assertCaller = () => {},
): Promise<RetireLegacyPackageBackups> {
  const assertCurrent = retainMutationAuthority(assertCaller);
  const warnings: string[] = [];
  let captured:
    | { root: string; parent: BigIntStats; entries: Array<{ path: string; identity: BigIntStats }> }
    | undefined;
  try {
    assertCurrent();
    const root = fsSync.realpathSync(globalRoot);
    const parent = fsSync.lstatSync(root, { bigint: true });
    const names = await fs.readdir(root);
    assertCurrent();
    assertPackagePathIdentity(root, parent);
    const entries = names.filter(isLegacyPackageBackupName).flatMap((name) => {
      const entry = path.join(root, name);
      const identity = fsSync.lstatSync(entry, { bigint: true, throwIfNoEntry: false });
      return identity && (identity.isDirectory() || identity.isSymbolicLink())
        ? [{ path: entry, identity }]
        : [];
    });
    captured = { root, parent, entries };
  } catch (error) {
    assertCurrent();
    warnings.push(
      `Historical package backups were not inspected in ${globalRoot}; retained for later cleanup: ${formatErrorMessage(error)}`,
    );
  }
  return async (assertRetirementOwner: () => void, cleanupDeadlineAtMs: number) => {
    const assertOwner = retainMutationAuthority(assertRetirementOwner);
    assertOwner();
    const messages = [...warnings];
    if (!captured) {
      return messages;
    }
    const { root, parent, entries } = captured;
    const inspectionDeadlineAtMs = Math.min(
      cleanupDeadlineAtMs,
      performance.now() + PKG_INSPECTION_TIMEOUT_MS,
    );
    for (const entry of entries) {
      try {
        assertOwner();
        const remainingMs = Math.floor(inspectionDeadlineAtMs - performance.now());
        if (remainingMs <= 0) {
          messages.push(
            `Historical package backups retained in ${root}: system package inspection budget expired`,
          );
          break;
        }
        let warning: string | undefined;
        const inspection = createSystemPackageOwnershipInspection(remainingMs, {
          onWarning: (message) => {
            warning = message;
          },
        });
        if (entry.identity.isSymbolicLink()) {
          await inspection.assertEntryUnowned(entry.path);
        } else {
          await inspection.assertUnowned(entry.path);
        }
        if (warning) {
          messages.push(`Historical package backups retained in ${root}: ${warning}`);
          break;
        }
        const message = await discardPackageUpdateBackup(
          entry.path,
          "historical package backup",
          root,
          () => {
            assertOwner();
            if (fsSync.realpathSync(globalRoot) !== root) {
              throw new Error("Global package directory changed before historical backup cleanup");
            }
            assertPackagePathIdentity(root, parent);
            // The owned unlink may have finished; a replacement must never be adopted.
            if (fsSync.lstatSync(entry.path, { throwIfNoEntry: false })) {
              assertPackagePathIdentity(entry.path, entry.identity);
            }
          },
          cleanupDeadlineAtMs,
        );
        if (message) {
          messages.push(message);
        }
      } catch (error) {
        assertOwner();
        messages.push(
          `Historical package backup retained at ${entry.path}: ${formatErrorMessage(error)}`,
        );
        if (error instanceof SystemPackageOwnershipError && !error.owned) {
          break;
        }
      }
    }
    assertOwner();
    return messages;
  };
}

/** Refusal occurred before transaction handoff or any live package mutation. */
export async function retireRefusedPackageSwap(
  activation: Pick<ReturnType<typeof createPublicationOwner>, "disarmRollback" | "retireVerified">,
  refusal: unknown,
  onWarning: (message: string | undefined) => void,
): Promise<void> {
  try {
    // The publication owner verifies the original live generation and launchers
    // before disarming forward recovery and removing its prepared candidate.
    await activation.disarmRollback();
    onWarning(await activation.retireVerified());
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
  activation: { retireVerified: () => Promise<string | undefined> } | undefined;
  rootLink: Awaited<ReturnType<typeof createNpmPackageRootLinkLifecycle>> | undefined;
  hadPackage: boolean;
  previousRoot: PackageRootIntegrityFingerprint | undefined;
  backupRoot: string;
  databaseBackupRoot: string | undefined;
  retireLegacyBackups?: RetireLegacyPackageBackups;
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
    const retained = await activation.retireVerified();
    if (retained) {
      messages.push(retained);
    }
    // Verified completion relinquishes recovery custody, including retained evidence.
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
  if (params.retireLegacyBackups) {
    messages.push(
      ...(await params.retireLegacyBackups(assertRetirementCurrent, cleanupDeadlineAtMs)),
    );
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
