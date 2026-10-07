import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import { hasErrnoCode } from "./errno.js";
import { resolveExecutablePath } from "./executable-path.js";
import { supersedePackageActivationCustody } from "./package-update-activation-custody.js";
import {
  openPackageActivationJournal,
  assertPackageActivationOperation,
  assertPackageActivationLayout,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
  isPackageActivationComplete,
  resolvePackageActivationAnchor,
  packageActivationIdentity,
} from "./package-update-activation-journal.js";
import {
  preparePackageActivationJournal,
  resolvePackageActivationRecoveryCommand as recoveryCommand,
  type PackageActivationPreparation,
} from "./package-update-activation-prepare.js";
import { verifyPackagePublicationSettlement } from "./package-update-activation-settlement.js";
import {
  readReleasedPackageActivationReceipt,
  readPackageActivationRecordStatus as status,
  type PackageActivationStatus,
} from "./package-update-activation-status.js";
import { createPublicationOwner } from "./package-update-publication-owner.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import {
  assertManagedUpdateLeaseDatabaseIdentity,
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import { supportsPostCoreExecutor } from "./update-post-core-capability.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

export type { PackageActivationStatus } from "./package-update-activation-status.js";

/** Read-only correlation; callers still need a privately registered live fence. */
function readPackageActivationContinuation(installKey: string) {
  const anchor = resolvePackageActivationAnchor(installKey);
  const released = readReleasedPackageActivationReceipt(installKey);
  if (released) {
    throw new Error(
      `Package publication recovery is pending. With the recorded external runtime, run ${released.recoveryCommand}, then use that original helper to repair or retire; keep other package managers stopped.`,
    );
  }
  assertPackageActivationLayout(anchor);
  const journalPath = resolvePackageActivationJournalPath(anchor);
  if (!fs.lstatSync(journalPath, { throwIfNoEntry: false })) {
    if (
      fs.lstatSync(anchor, { throwIfNoEntry: false }) ||
      fs.lstatSync(resolvePackageActivationControl(anchor), { throwIfNoEntry: false })
    ) {
      throw new Error(
        `Incomplete or legacy recovery artifacts require their original owner: ${anchor}. The next mutable update is blocked.`,
      );
    }
    return undefined;
  }
  const record = openPackageActivationJournal(anchor).read();
  if (isPackageActivationComplete(anchor, record)) {
    return undefined;
  }
  if (record.descriptor.authority.installKey !== installKey) {
    throw new Error("Package publication is incomplete; its original continuation cannot run.");
  }
  assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  if (record.phase === "superseded") {
    throw new Error("Package recovery settlement is incomplete; run openclaw update repair.");
  }
  if (record.phase !== "publication-complete") {
    throw new Error(
      `Package publication is incomplete; its original continuation cannot run. With the recorded external runtime, run ${recoveryCommand(record)} status, then repair or retire; keep other package managers stopped.`,
    );
  }
  return record.descriptor.authority;
}

export function assertNoPendingPackageActivation(
  installKey: string,
  options?: { continuation?: UpdateRecoveryFence },
): void {
  const authority = readPackageActivationContinuation(installKey);
  if (!authority) {
    return;
  }
  if (
    options?.continuation &&
    isDeepStrictEqual(authority, captureUpdateCommandExecutorAuthority(options.continuation))
  ) {
    return;
  }
  const anchor = resolvePackageActivationAnchor(installKey);
  const record = openPackageActivationJournal(anchor).read();
  throw new Error(
    `Package publication recovery is pending. With the recorded external runtime, run ${recoveryCommand(record)} status, then repair or retire; keep other package managers stopped.`,
  );
}

export async function preparePackageActivation(
  params: PackageActivationPreparation & { installTarget: ResolvedGlobalInstallTarget },
) {
  const fence = params.options.fence;
  const assertOriginal = fence.assertCurrent.bind(fence);
  const options = { ...params.options, fence };
  if (
    process.platform === "win32" ||
    params.installTarget.manager !== "npm" ||
    params.installTarget.directNodeModulesRoot ||
    !(await fsp.lstat(params.stageRoot)).isDirectory()
  ) {
    return undefined;
  }
  const nodeRunner = resolveExecutablePath(options.runtime.path, { useCache: false });
  assertOriginal();
  if (!nodeRunner) {
    options.onUnavailable?.(
      "Standalone package publication repair is unavailable: the selected runtime executable could not be resolved.",
    );
    return undefined;
  }
  const capable = await supportsPostCoreExecutor(params.stageRoot, nodeRunner);
  assertOriginal();
  if (!capable) {
    // Older targets keep their shipped update path, without a
    // journal whose post-core receiver cannot prove original ownership.
    options.onUnavailable?.(
      "Standalone package publication repair is unavailable for this target: its update worker does not support delegated post-core execution.",
    );
    return undefined;
  }
  const prepared = await preparePackageActivationJournal({ ...params, options }, assertOriginal);
  const owner = createPublicationOwner(
    prepared.anchor,
    prepared.journal,
    assertOriginal,
    prepared.initial,
    undefined,
    options.onWarning,
  );
  return { ...prepared, ...owner };
}

export function readPackageActivationReceipt(installKey: string):
  | (Omit<PackageActivationStatus, "phase"> & {
      phase: PackageActivationStatus["phase"] | "retired";
      recoveryCommand?: string;
    })
  | undefined {
  const released = readReleasedPackageActivationReceipt(installKey);
  if (released) {
    return released;
  }
  const anchor = resolvePackageActivationAnchor(installKey);
  if (!fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
    readPackageActivationContinuation(installKey);
    return undefined;
  }
  const record = openPackageActivationJournal(anchor).read();
  const receipt = status(record);
  if (
    receipt.phase !== "complete" ||
    (record.intent?.kind !== "recovery-lease-identity-changed" &&
      record.intent?.kind !== "recovery-lease-missing")
  ) {
    assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  }
  return receipt.phase === "complete" || record.phase === "superseded"
    ? receipt
    : { ...receipt, recoveryCommand: `${recoveryCommand(record)} status` };
}

/** Explicit repair settles untouched preparation or obsolete custody, never pending restoration. */
export async function settlePendingPackageActivation(installKey: string) {
  const anchor = resolvePackageActivationAnchor(installKey);
  if (!fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
    return undefined;
  }
  const journal = openPackageActivationJournal(anchor);
  const admission = await journal.readForRecovery();
  const initial = admission.record;
  const complete = isPackageActivationComplete(anchor, initial);
  const receipt =
    initial.intent && "detail" in initial.intent && initial.intent.detail
      ? {
          operationId: initial.descriptor.operationId,
          reason: initial.intent.kind,
          retained: `${anchor}.superseded-${initial.descriptor.operationId}`,
          detail: initial.intent.detail,
        }
      : undefined;
  if (complete && initial.intent?.kind !== "publication-settled-external-change") {
    return receipt;
  }
  const originalAuthority = initial.descriptor.authority;
  let currentDatabase: ManagedUpdateLeaseDatabaseIdentity;
  // A recreated file can reuse the lost inode. Keep the recorded loss when
  // resuming an interrupted custody transfer.
  let leaseWasMissing =
    initial.phase === "superseded" && initial.intent?.kind === "recovery-lease-missing";
  try {
    currentDatabase = captureManagedUpdateLeaseDatabaseIdentity(originalAuthority.databasePath);
  } catch (error) {
    if (
      !hasErrnoCode(error, "ENOENT") ||
      fs.lstatSync(originalAuthority.databasePath, { throwIfNoEntry: false })
    ) {
      throw error;
    }
    // A reboot can remove the temporary store. Its owner provisions it; the
    // fresh executor below still fences every change to retained package custody.
    currentDatabase = createManagedHandoffLeaseDatabase(originalAuthority.databasePath)(true, () =>
      captureManagedUpdateLeaseDatabaseIdentity(originalAuthority.databasePath),
    );
    leaseWasMissing = true;
  }
  const leaseIdentityChanged =
    leaseWasMissing ||
    currentDatabase.databasePath !== originalAuthority.databasePath ||
    currentDatabase.databaseIdentity !== originalAuthority.databaseIdentity ||
    currentDatabase.parentIdentity !== originalAuthority.parentIdentity;
  // Reporting can replay a completed receipt, but an external settlement must
  // first release its old lease identity after reboot so the next preparation works.
  if (complete && !leaseIdentityChanged) {
    return receipt;
  }
  const reason = leaseWasMissing
    ? "recovery-lease-missing"
    : leaseIdentityChanged
      ? "recovery-lease-identity-changed"
      : "superseded-by-manual-install";
  const replacementIdentity = packageActivationIdentity(installKey, true);
  const externalPublication =
    !leaseIdentityChanged &&
    replacementIdentity === initial.descriptor.candidate.identity &&
    (initial.phase === "publishing" ||
      (initial.phase === "superseded" &&
        initial.intent?.kind === "publication-settled-external-change"));
  const publicationNotStarted =
    !leaseIdentityChanged &&
    replacementIdentity === initial.descriptor.previous.identity &&
    ((initial.phase === "prepared" &&
      initial.intent === null &&
      initial.publications.length === 0) ||
      initial.phase === "aborted");
  if (
    !publicationNotStarted &&
    !externalPublication &&
    !leaseIdentityChanged &&
    [initial.descriptor.previous.identity, initial.descriptor.candidate.identity].includes(
      replacementIdentity,
    )
  ) {
    assertNoPendingPackageActivation(installKey);
    return undefined;
  }
  return withUpdateCommandExecutor(
    randomUUID(),
    async (executor) => {
      const fence = await executor.enter(installKey);
      assertManagedUpdateLeaseDatabaseIdentity(currentDatabase);
      admission.admit(fence.assertCurrent);
      journal.assertCurrent(initial);
      if (packageActivationIdentity(installKey, true) !== replacementIdentity) {
        throw new Error("The installed package changed before recovery settlement.");
      }
      if (publicationNotStarted) {
        const assertPrevious = () => {
          fence.assertCurrent();
          if (
            packageActivationIdentity(installKey, true) !== initial.descriptor.previous.identity
          ) {
            throw new Error("The installed package changed before preparation retirement.");
          }
        };
        const owner = createPublicationOwner(anchor, journal, assertPrevious, initial);
        if (initial.phase === "prepared") {
          await owner.preflight("repair");
          await owner.disarmRollback();
        }
        await owner.retire();
        return {
          operationId: initial.descriptor.operationId,
          reason: "publication-not-started",
          retained: undefined,
          detail: undefined,
        };
      }
      const verified = externalPublication
        ? await verifyPackagePublicationSettlement(anchor, initial, fence.assertCurrent)
        : undefined;
      const settlement: Parameters<typeof supersedePackageActivationCustody>[4] = verified
        ? {
            kind: "publication-settled-external-change",
            detail: receipt?.detail ?? verified.detail,
          }
        : { kind: reason, detail: receipt?.detail };
      const retained = await supersedePackageActivationCustody(
        anchor,
        journal,
        initial,
        verified?.assertUnchanged ?? fence.assertCurrent,
        settlement,
      );
      return {
        operationId: initial.descriptor.operationId,
        retained,
        reason: settlement.kind,
        detail: settlement.detail,
      };
    },
    { existingAuthority: { ...originalAuthority, ...currentDatabase } },
  );
}
export async function readPackageActivationStatus(
  anchor: string,
  operationId: string,
): Promise<PackageActivationStatus> {
  const record = openPackageActivationJournal(anchor).read();
  assertPackageActivationOperation(record, operationId);
  assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  return status(record);
}

export async function runPackageActivationRecovery(
  anchor: string,
  action: "repair" | "retire",
  operationId: string,
): Promise<PackageActivationStatus> {
  const journal = openPackageActivationJournal(anchor);
  const admission = await journal.readForRecovery();
  const initial = admission.record;
  assertPackageActivationOperation(initial, operationId);
  const complete = isPackageActivationComplete(anchor, initial);
  if (complete) {
    assertManagedUpdateLeaseDatabaseIdentity(initial.descriptor.authority);
  } else {
    // Reject malformed/foreign/disarmed recovery before acquiring a new writer.
    // Admission is still followed by the same observations under the fresh fence.
    await createPublicationOwner(
      anchor,
      journal,
      () => {
        assertManagedUpdateLeaseDatabaseIdentity(initial.descriptor.authority);
      },
      initial,
      admission.assertUnchanged,
    ).preflight(action);
  }
  return withUpdateCommandExecutor(
    randomUUID(),
    async (executor) => {
      const fence = await executor.enter(initial.descriptor.authority.installKey);
      assertManagedUpdateLeaseDatabaseIdentity(initial.descriptor.authority);
      admission.admit(fence.assertCurrent);
      journal.assertCurrent(initial);
      const owner = createPublicationOwner(anchor, journal, fence.assertCurrent, initial);
      if (complete) {
        return owner.persistRetirement();
      }
      return action === "repair" ? owner.publish(true) : owner.retire();
    },
    { existingAuthority: initial.descriptor.authority },
  );
}
