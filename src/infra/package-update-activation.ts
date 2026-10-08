import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { resolveExecutablePath } from "./executable-path.js";
import { retainMutationAuthority } from "./mutation-authority.js";
import {
  archivePackageActivationCustody,
  settlePackageActivationCustody,
} from "./package-update-activation-custody.js";
import {
  openPackageActivationJournal,
  assertPackageActivationOperation,
  assertPackageActivationLayout,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
  resolvePackageActivationHelper,
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
  prepareManagedHandoffLeaseDatabaseIdentity,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import { supportsPostCoreExecutor } from "./update-post-core-capability.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

export type { PackageActivationStatus } from "./package-update-activation-status.js";

/** Reconcile completed receipts; unfinished operations still require a live fence. */
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
  const record = openPackageActivationJournal(anchor).readForAdmission(installKey);
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
  const assertOriginal = retainMutationAuthority(fence.assertCurrent.bind(fence));
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
  const anchor = resolvePackageActivationAnchor(params.liveRoot);
  if (fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
    const journal = openPackageActivationJournal(anchor);
    const prior = journal.read();
    if (
      isPackageActivationComplete(anchor, prior) &&
      (prior.phase === "superseded" ||
        fs.lstatSync(anchor, { throwIfNoEntry: false }) ||
        fs.lstatSync(resolvePackageActivationHelper(anchor), { throwIfNoEntry: false }))
    ) {
      try {
        journal.archiveSettled(prior, assertOriginal);
      } catch (error) {
        assertOriginal();
        if (fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
          journal.assertCurrent(prior);
        }
        // A closed slot cannot regain rollback authority. Keep inaccessible
        // evidence and use the existing non-journaled package-swap owner.
        options.onUnavailable?.(
          `Completed package recovery evidence retained; standalone publication repair is unavailable for this update: ${formatErrorMessage(error)}`,
        );
        return undefined;
      }
    }
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
  if (receipt.phase !== "complete") {
    assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  }
  return receipt.phase === "complete" || record.phase === "superseded"
    ? receipt
    : { ...receipt, recoveryCommand: `${recoveryCommand(record)} status` };
}

type PackageActivationSettlement = {
  operationId: string;
  reason: string;
  retained: string | undefined;
  detail: string | undefined;
  warning?: string;
};

/** Explicit repair settles untouched preparation or obsolete custody, never pending restoration. */
export async function settlePendingPackageActivation(
  installKey: string,
  onSettled?: (settlement: PackageActivationSettlement) => void,
) {
  const anchor = resolvePackageActivationAnchor(installKey);
  if (!fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
    return undefined;
  }
  const journal = openPackageActivationJournal(anchor);
  const admission = await journal.readForRecovery();
  const initial = admission.record;
  const complete = isPackageActivationComplete(anchor, initial);
  if (initial.phase === "rollback-in-progress") {
    throw new Error("Package restoration is unfinished; its rollback owner must finish recovery.");
  }
  const receipt =
    initial.phase === "superseded" && initial.intent && "settled" in initial.intent
      ? {
          operationId: initial.descriptor.operationId,
          reason: initial.intent.kind,
          retained: `${anchor}.superseded-${initial.descriptor.operationId}`,
          detail: initial.intent.detail,
        }
      : complete
        ? {
            operationId: initial.descriptor.operationId,
            reason: "publication-retired",
            retained: `${anchor}.superseded-${initial.descriptor.operationId}`,
            detail: undefined,
          }
        : undefined;
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
    currentDatabase = await prepareManagedHandoffLeaseDatabaseIdentity(
      originalAuthority.databasePath,
    );
    leaseWasMissing = true;
  }
  const leaseIdentityChanged =
    leaseWasMissing ||
    currentDatabase.databasePath !== originalAuthority.databasePath ||
    currentDatabase.databaseIdentity !== originalAuthority.databaseIdentity ||
    currentDatabase.parentIdentity !== originalAuthority.parentIdentity;
  const reason = leaseWasMissing
    ? "recovery-lease-missing"
    : leaseIdentityChanged
      ? "recovery-lease-identity-changed"
      : "superseded-by-manual-install";
  const replacementIdentity = packageActivationIdentity(installKey, true);
  const externalPublication =
    replacementIdentity === initial.descriptor.candidate.identity &&
    (initial.phase === "publishing" ||
      initial.phase === "publication-complete" ||
      (initial.phase === "superseded" &&
        initial.intent?.kind === "publication-settled-external-change"));
  const unusedPreparation =
    replacementIdentity === initial.descriptor.previous.identity &&
    ((initial.phase === "prepared" &&
      initial.intent === null &&
      initial.publications.length === 0) ||
      initial.phase === "aborted");
  const publicationNotStarted = !leaseIdentityChanged && unusedPreparation;
  if (
    !complete &&
    !publicationNotStarted &&
    !externalPublication &&
    !(leaseIdentityChanged && (unusedPreparation || initial.phase === "superseded")) &&
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
      const assertCurrent = retainMutationAuthority(fence.assertCurrent);
      assertManagedUpdateLeaseDatabaseIdentity(currentDatabase);
      admission.admit(assertCurrent);
      journal.assertCurrent(initial);
      if (packageActivationIdentity(installKey, true) !== replacementIdentity) {
        throw new Error("The installed package changed before recovery settlement.");
      }
      const finish = (settled: PackageActivationSettlement, archive = true) => {
        // Keep the active receipt replayable until the caller has recorded the
        // outcome. Archival then removes history from old readers' admission path.
        onSettled?.(settled);
        if (archive && settled.retained) {
          settled.warning = archivePackageActivationCustody(
            anchor,
            journal,
            journal.read(),
            assertCurrent,
          );
        }
        return settled;
      };
      if (complete && receipt) {
        return finish(receipt);
      }
      if (publicationNotStarted) {
        const assertPrevious = () => {
          assertCurrent();
          if (
            packageActivationIdentity(installKey, true) !== initial.descriptor.previous.identity
          ) {
            throw new Error("The installed package changed before preparation retirement.");
          }
        };
        const owner = createPublicationOwner(anchor, journal, assertPrevious, initial);
        if (initial.phase === "prepared") {
          try {
            await owner.disarmRollback();
          } catch {
            // A damaged unused candidate is not restoration input. Verified
            // retirement rechecks the live previous package, launchers, journal
            // and sticky authority before preserving that candidate as evidence.
          }
        }
        const settled: PackageActivationSettlement = {
          operationId: initial.descriptor.operationId,
          reason: "publication-not-started",
          retained: undefined,
          detail: undefined,
        };
        const warning = await owner.retireVerified((detail) => {
          settled.retained = `${anchor}.superseded-${initial.descriptor.operationId}`;
          settled.detail = detail;
          onSettled?.(settled);
        });
        // Preserved custody reported before archival; ordinary retirement keeps
        // its bounded active receipt, so either reporting failure is replayable.
        return warning ? { ...settled, warning } : finish(settled, false);
      }
      if (externalPublication) {
        const verified = await verifyPackagePublicationSettlement(initial, assertCurrent);
        // Persist a lost launcher rename acknowledgement before disarming recovery.
        const outcome = await syncDirectory(initial.descriptor.binDir);
        verified.assertUnchanged();
        journal.assertCurrent(initial);
        requireDirectorySync(outcome, "Package settlement launcher directory");
        const settled = {
          operationId: initial.descriptor.operationId,
          retained: `${anchor}.superseded-${initial.descriptor.operationId}`,
          reason: "publication-settled-external-change",
          detail: receipt?.detail ?? verified.detail,
        };
        const result = settlePackageActivationCustody({
          anchor,
          journal,
          record: initial,
          settlement: {
            kind: "publication-settled-external-change",
            replacementIdentity,
            settled: true,
            detail: settled.detail,
          },
          assertCurrent: verified.assertUnchanged,
          onSettled: () => onSettled?.(settled),
        });
        return { ...settled, warning: result.archiveWarning };
      }
      // Legacy half-transfers retain their original replacement fact. Today's
      // live identity guards this closure; old artifact identities do not.
      const settlement: Parameters<typeof settlePackageActivationCustody>[0]["settlement"] =
        initial.phase === "superseded" && initial.intent && "settled" in initial.intent
          ? initial.intent
          : { kind: reason, replacementIdentity, settled: true, detail: receipt?.detail };
      const settled = {
        operationId: initial.descriptor.operationId,
        retained: `${anchor}.superseded-${initial.descriptor.operationId}`,
        reason: settlement.kind,
        detail: settlement.detail,
      };
      const result = settlePackageActivationCustody({
        anchor,
        journal,
        record: initial,
        settlement,
        assertCurrent: () => {
          assertCurrent();
          if (packageActivationIdentity(installKey, true) !== replacementIdentity) {
            throw new Error("The installed package changed during recovery settlement.");
          }
        },
        onSettled: () => onSettled?.(settled),
      });
      return { ...settled, warning: result.archiveWarning };
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
  const receipt = status(record);
  if (receipt.phase !== "complete") {
    assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  }
  return receipt;
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
  const authority = complete
    ? {
        ...initial.descriptor.authority,
        ...(await prepareManagedHandoffLeaseDatabaseIdentity(
          initial.descriptor.authority.databasePath,
        )),
      }
    : initial.descriptor.authority;
  if (!complete) {
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
      assertManagedUpdateLeaseDatabaseIdentity(authority);
      admission.admit(fence.assertCurrent);
      journal.assertCurrent(initial);
      if (complete) {
        // Finish a lost directory-sync acknowledgement under today's authority,
        // without granting any effect from the historical package identities.
        const outcome = await syncDirectory(
          path.dirname(resolvePackageActivationJournalPath(anchor)),
        );
        fence.assertCurrent();
        journal.assertCurrent(initial);
        requireDirectorySync(outcome, "Package helper retirement");
        return status(initial);
      }
      const owner = createPublicationOwner(anchor, journal, fence.assertCurrent, initial);
      return action === "repair" ? owner.publish(true) : owner.retire();
    },
    { existingAuthority: authority },
  );
}
