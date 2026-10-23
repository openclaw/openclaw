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
import {
  openPackageActivationJournal,
  packageActivationIdentity,
  assertPackageActivationOperation,
  assertPackageActivationLayout,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
  isPackageActivationComplete,
  resolvePackageActivationAnchor,
} from "./package-update-activation-journal.js";
import {
  preparePackageActivationJournal,
  resolvePackageActivationRecoveryCommand as recoveryCommand,
  type PackageActivationPreparation,
} from "./package-update-activation-prepare.js";
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
} from "./update-managed-service-handoff-database.js";
import { supportsPostCoreExecutor } from "./update-post-core-capability.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

export type { PackageActivationStatus } from "./package-update-activation-status.js";

function packageActivationLeaseChanged(
  authority: Parameters<typeof assertManagedUpdateLeaseDatabaseIdentity>[0],
) {
  try {
    return !isDeepStrictEqual(captureManagedUpdateLeaseDatabaseIdentity(authority.databasePath), {
      databasePath: authority.databasePath,
      databaseIdentity: authority.databaseIdentity,
      parentIdentity: authority.parentIdentity,
    });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

/** Read-only correlation; callers still need a privately registered live fence. */
function readPackageActivationContinuation(installKey: string, dryRun?: boolean) {
  const anchor = resolvePackageActivationAnchor(installKey);
  const released = readReleasedPackageActivationReceipt(installKey);
  if (released) {
    throw new Error(
      `Package publication recovery is pending. With an external Node, run ${released.recoveryCommand}, then use that original helper to repair or retire; keep other package managers stopped.`,
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
  if (
    dryRun &&
    ["prepared", "publishing", "publication-complete", "aborted"].includes(record.phase) &&
    [record.descriptor.previous.identity, record.descriptor.candidate.identity].includes(
      packageActivationIdentity(installKey, true),
    ) &&
    packageActivationLeaseChanged(record.descriptor.authority)
  ) {
    return undefined;
  }
  assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  if (record.phase !== "publication-complete") {
    throw new Error(
      `Package publication is incomplete; its original continuation cannot run. With an external Node, run ${recoveryCommand(record)} status, then repair or retire; keep other package managers stopped.`,
    );
  }
  return record.descriptor.authority;
}

export function assertNoPendingPackageActivation(
  installKey: string,
  options?: { continuation?: UpdateRecoveryFence; dryRun?: boolean },
): void {
  const authority = readPackageActivationContinuation(installKey, options?.dryRun);
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
    `Package publication recovery is pending. With an external Node, run ${recoveryCommand(record)} status, then repair or retire; keep other package managers stopped.`,
  );
}

type StalePackageActivationSettlement = {
  operationId: string;
  reason: "recovery-lease-missing" | "recovery-lease-identity-changed";
  retained: string;
};

/** Retain verified package recovery evidence whose original executor lease is gone. */
export async function settleStalePackageActivation(
  installKey: string,
  options?: { dryRun?: boolean },
): Promise<StalePackageActivationSettlement | undefined> {
  const anchor = resolvePackageActivationAnchor(installKey);
  const control = resolvePackageActivationControl(anchor);
  if (!fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
    return undefined;
  }
  const journal = openPackageActivationJournal(anchor);
  const admission = options?.dryRun ? undefined : await journal.readForRecovery();
  const initial = admission?.record ?? journal.read();
  if (!["prepared", "publishing", "publication-complete", "aborted"].includes(initial.phase)) {
    return undefined;
  }
  if (initial.descriptor.authority.installKey !== installKey) {
    return undefined;
  }
  let missing: boolean;
  try {
    captureManagedUpdateLeaseDatabaseIdentity(
      initial.descriptor.authority.databasePath,
      initial.descriptor.authority,
    );
    return undefined;
  } catch (error) {
    missing = hasErrnoCode(error, "ENOENT");
    if (!missing && !(error instanceof Error && error.message.includes("identity changed"))) {
      throw error;
    }
  }
  const liveIdentity = packageActivationIdentity(installKey, true);
  if (
    ![initial.descriptor.previous.identity, initial.descriptor.candidate.identity].includes(
      liveIdentity,
    )
  ) {
    return undefined;
  }
  const operationId = initial.descriptor.operationId;
  const retained = `${anchor}.superseded-${operationId}`;
  const settlement: StalePackageActivationSettlement = {
    operationId,
    reason: missing ? "recovery-lease-missing" : "recovery-lease-identity-changed",
    retained,
  };
  const verify = async (assertCurrent: () => void) => {
    journal.assertCurrent(initial);
    if (packageActivationIdentity(installKey, true) !== liveIdentity) {
      throw new Error("The installed package changed before stale recovery settlement.");
    }
    await createPublicationOwner(
      anchor,
      journal,
      assertCurrent,
      initial,
    ).preflightStaleSettlement();
  };
  if (options?.dryRun) {
    await verify(() => journal.assertCurrent(initial));
    return settlement;
  }
  return withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const fence = await executor.enter(installKey);
    admission!.admit(fence.assertCurrent);
    await verify(fence.assertCurrent);
    const retainedControl = `${retained}.control`;
    if (
      fs.lstatSync(retained, { throwIfNoEntry: false }) ||
      fs.lstatSync(retainedControl, { throwIfNoEntry: false })
    ) {
      throw new Error("Retained package recovery evidence already exists.");
    }
    const controlIdentity = packageActivationIdentity(control, true);
    await fsp.rename(anchor, retained);
    fence.assertCurrent();
    requireDirectorySync(await syncDirectory(path.dirname(anchor)), "Package recovery evidence");
    fence.assertCurrent();
    if (packageActivationIdentity(control, true) !== controlIdentity) {
      throw new Error("Package recovery control changed during evidence retention.");
    }
    await fsp.rename(control, retainedControl);
    fence.assertCurrent();
    requireDirectorySync(await syncDirectory(path.dirname(control)), "Package recovery evidence");
    return settlement;
  });
}

/** Explicit repair retires untouched preparation or a verified externally published candidate. */
export async function settlePendingPackageActivation(installKey: string) {
  const anchor = resolvePackageActivationAnchor(installKey);
  if (!fs.lstatSync(resolvePackageActivationJournalPath(anchor), { throwIfNoEntry: false })) {
    readPackageActivationContinuation(installKey);
    return undefined;
  }
  const journal = openPackageActivationJournal(anchor);
  const admission = await journal.readForRecovery();
  const initial = admission.record;
  const liveIdentity = packageActivationIdentity(installKey, true);
  const publicationNotStarted =
    initial.descriptor.authority.installKey === installKey &&
    liveIdentity === initial.descriptor.previous.identity &&
    ((initial.phase === "prepared" &&
      initial.intent === null &&
      initial.publications.length === 0) ||
      initial.phase === "aborted");
  const externalPublication =
    initial.descriptor.authority.installKey === installKey &&
    liveIdentity === initial.descriptor.candidate.identity &&
    initial.phase === "prepared";
  if (!publicationNotStarted && !externalPublication) {
    // Preserve the shipped pending-publication refusal and completed-operation behavior.
    assertNoPendingPackageActivation(installKey);
    return undefined;
  }
  const selected = externalPublication ? "candidate" : "previous";
  const assertSelected = () => {
    assertManagedUpdateLeaseDatabaseIdentity(initial.descriptor.authority);
    if (packageActivationIdentity(installKey, true) !== initial.descriptor[selected].identity) {
      throw new Error("The installed package changed before recovery settlement.");
    }
  };
  // Read-only admission rejects altered closure before acquiring the original writer.
  await createPublicationOwner(
    anchor,
    journal,
    assertSelected,
    initial,
    admission.assertUnchanged,
  ).preflight(initial.phase === "prepared" ? "repair" : "retire");
  return withUpdateCommandExecutor(
    randomUUID(),
    async (executor) => {
      const fence = await executor.enter(initial.descriptor.authority.installKey);
      assertSelected();
      admission.admit(fence.assertCurrent);
      journal.assertCurrent(initial);
      const owner = createPublicationOwner(
        anchor,
        journal,
        () => {
          fence.assertCurrent();
          assertSelected();
        },
        initial,
      );
      if (externalPublication) {
        await owner.publish(true);
      } else if (initial.phase === "prepared") {
        await owner.preflight("repair");
        await owner.disarmRollback();
      }
      await owner.retire();
      return {
        operationId: initial.descriptor.operationId,
        reason: externalPublication
          ? "publication-settled-external-change"
          : "publication-not-started",
      };
    },
    { existingAuthority: initial.descriptor.authority },
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
    process.versions.bun ||
    params.installTarget.manager !== "npm" ||
    params.installTarget.directNodeModulesRoot ||
    !(await fsp.lstat(params.stageRoot)).isDirectory()
  ) {
    return undefined;
  }
  const nodeRunner = resolveExecutablePath(options.nodeRunner, { useCache: false });
  assertOriginal();
  if (!nodeRunner) {
    options.onUnavailable?.(
      "Standalone package publication repair is unavailable: the selected Node executable could not be resolved.",
    );
    return undefined;
  }
  // Probe and seal the same selected runtime before the probe clears its environment.
  options.nodeRunner = fs.realpathSync(nodeRunner);
  const capable = await supportsPostCoreExecutor(params.stageRoot, options.nodeRunner);
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
  const owner = createPublicationOwner(prepared.anchor, prepared.journal, assertOriginal);
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
  assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  const receipt = status(record);
  return receipt.phase === "complete"
    ? receipt
    : { ...receipt, recoveryCommand: `${recoveryCommand(record)} status` };
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
