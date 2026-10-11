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
  isPackageActivationComplete,
  resolvePackageActivationAnchor,
  packageActivationIdentity,
  type PackageActivationRecord,
} from "./package-update-activation-journal.js";
import { LEGACY_PACKAGE_RECOVERY_HELPER } from "./package-update-activation-paths.js";
import {
  preparePackageActivationJournal,
  PackageActivationArchiveError,
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
} from "./update-managed-service-handoff-database.js";
import { supportsPostCoreExecutor } from "./update-post-core-capability.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

export type { PackageActivationStatus } from "./package-update-activation-status.js";

function inspectPackageActivationLease({
  databasePath,
  databaseIdentity,
  parentIdentity,
}: PackageActivationRecord["descriptor"]["authority"]) {
  let current: ReturnType<typeof captureManagedUpdateLeaseDatabaseIdentity> | undefined;
  try {
    current = captureManagedUpdateLeaseDatabaseIdentity(databasePath);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT") || fs.lstatSync(databasePath, { throwIfNoEntry: false })) {
      throw error;
    }
  }
  return {
    current,
    changed: !isDeepStrictEqual(current, { databasePath, databaseIdentity, parentIdentity }),
  };
}

/** Reconcile completed receipts; unfinished operations still require a live fence. */
function readPackageActivationContinuation(installKey: string, dryRun?: boolean) {
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
  if (
    dryRun &&
    ["prepared", "publishing", "publication-complete", "aborted", "superseded"].includes(
      record.phase,
    ) &&
    [record.descriptor.previous.identity, record.descriptor.candidate.identity].includes(
      packageActivationIdentity(installKey, true),
    ) &&
    inspectPackageActivationLease(record.descriptor.authority).changed
  ) {
    return undefined;
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
  return record;
}

export function assertNoPendingPackageActivation(
  installKey: string,
  options?: { continuation?: UpdateRecoveryFence; dryRun?: boolean },
): void {
  const record = readPackageActivationContinuation(installKey, options?.dryRun);
  if (!record) {
    return;
  }
  if (
    options?.continuation &&
    isDeepStrictEqual(
      record.descriptor.authority,
      captureUpdateCommandExecutorAuthority(options.continuation),
    )
  ) {
    return;
  }
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
  let prepared;
  try {
    prepared = await preparePackageActivationJournal({ ...params, options }, assertOriginal);
  } catch (error) {
    if (!(error instanceof PackageActivationArchiveError)) {
      throw error;
    }
    // Closed evidence cannot regain rollback authority; use ordinary package swap.
    options.onUnavailable?.(error.message);
    return undefined;
  }
  const owner = createPublicationOwner(
    prepared.anchor,
    prepared.journal,
    assertOriginal,
    prepared.initial,
    options.onWarning,
    true,
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
  expectedCompleted?: PackageActivationRecord,
  options?: { onlyStaleLease?: boolean; dryRun?: boolean },
) {
  const anchor = resolvePackageActivationAnchor(installKey);
  if (!expectedCompleted && !fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
    assertNoPendingPackageActivation(installKey);
    return undefined;
  }
  const journal = openPackageActivationJournal(anchor);
  const admission = options?.dryRun ? undefined : await journal.readForRecovery();
  const initial = admission?.record ?? journal.read();
  const complete = isPackageActivationComplete(anchor, initial);
  if (expectedCompleted && (!complete || !isDeepStrictEqual(initial, expectedCompleted))) {
    throw new Error("Completed package receipt changed; inspect recovery status before retrying.");
  }
  if (initial.phase === "rollback-in-progress") {
    throw new Error("Package restoration is unfinished; its rollback owner must finish recovery.");
  }
  const priorSettlement =
    initial.phase === "superseded" && initial.intent && "settled" in initial.intent
      ? initial.intent
      : undefined;
  const receipt: PackageActivationSettlement | undefined =
    priorSettlement || complete
      ? {
          operationId: initial.descriptor.operationId,
          reason: priorSettlement?.kind ?? "publication-retired",
          retained: `${anchor}.superseded-${initial.descriptor.operationId}`,
          detail: priorSettlement?.detail,
        }
      : undefined;
  if (options?.onlyStaleLease && complete) {
    return options.dryRun ? receipt : undefined;
  }
  const originalAuthority = initial.descriptor.authority;
  const replacementIdentity = packageActivationIdentity(installKey, true);
  if (
    options?.onlyStaleLease &&
    ![initial.descriptor.previous.identity, initial.descriptor.candidate.identity].includes(
      replacementIdentity,
    )
  ) {
    return undefined;
  }
  const lease = inspectPackageActivationLease(originalAuthority);
  const leaseWasMissing =
    !lease.current ||
    (initial.phase === "superseded" && initial.intent?.kind === "recovery-lease-missing");
  const leaseIdentityChanged = leaseWasMissing || lease.changed;
  if (options?.onlyStaleLease && !leaseIdentityChanged) {
    return undefined;
  }
  const reason = leaseWasMissing
    ? "recovery-lease-missing"
    : leaseIdentityChanged
      ? "recovery-lease-identity-changed"
      : "superseded-by-manual-install";
  const externalPublication =
    replacementIdentity === initial.descriptor.candidate.identity &&
    (initial.phase === "prepared" ||
      initial.phase === "publishing" ||
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
    !(
      leaseIdentityChanged &&
      (unusedPreparation ||
        (initial.phase === "publication-complete" &&
          replacementIdentity === initial.descriptor.previous.identity) ||
        initial.phase === "superseded")
    ) &&
    [initial.descriptor.previous.identity, initial.descriptor.candidate.identity].includes(
      replacementIdentity,
    )
  ) {
    assertNoPendingPackageActivation(installKey);
    return undefined;
  }
  if (options?.dryRun) {
    if (externalPublication) {
      await verifyPackagePublicationSettlement(initial, () => journal.assertCurrent(initial));
    }
    return {
      operationId: initial.descriptor.operationId,
      reason,
      retained: `${anchor}.superseded-${initial.descriptor.operationId}`,
      detail: undefined,
      warning: undefined,
    };
  }
  const currentDatabase =
    lease.current ??
    (await prepareManagedHandoffLeaseDatabaseIdentity(originalAuthority.databasePath));
  return withUpdateCommandExecutor(
    randomUUID(),
    async (executor) => {
      const fence = await executor.enter(installKey);
      const assertCurrent = retainMutationAuthority(fence.assertCurrent);
      assertManagedUpdateLeaseDatabaseIdentity(currentDatabase);
      admission!.admit(assertCurrent);
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
  const recoveryAction =
    action === "repair" &&
    initial.phase === "aborted" &&
    initial.descriptor.helperDigest === LEGACY_PACKAGE_RECOVERY_HELPER
      ? "retire"
      : action;
  const complete = isPackageActivationComplete(anchor, initial);
  const authority = complete
    ? {
        ...initial.descriptor.authority,
        ...(await prepareManagedHandoffLeaseDatabaseIdentity(
          initial.descriptor.authority.databasePath,
        )),
      }
    : initial.descriptor.authority;
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
      return recoveryAction === "repair" ? owner.publish(true) : owner.retire();
    },
    { existingAuthority: authority },
  );
}
