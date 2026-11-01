import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  isPackageActivationComplete,
  openPackageActivationJournal,
  packageActivationIdentity,
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPublicationOwner } from "./package-update-publication-owner.js";
import { readBuiltGatewayBuildId } from "./update-git-runtime.js";
import { verifyPackageUpdateRecovery } from "./update-global.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-identity.js";
import type { UpdateRecovery } from "./update-recovery.js";
import { withUpdateRunRead } from "./update-run-admission.js";
import { findUpdateGatewayStop } from "./update-run-gateway-stop.js";
import { readUpdateRunRecord, readUpdateRuns } from "./update-run-read.kernel.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { readCurrentGitUpdateRecovery } from "./update-runner-git-recovery.js";

/** This one-shot helper already owns the parked state; no installed snapshot worker is needed. */
export function readManagedHandoffUpdateRun(runId: string) {
  return withUpdateRunRead(({ db }) => readUpdateRunRecord(db, runId), { allowNativeRead: true });
}

export function readManagedHandoffGatewayStop() {
  return withUpdateRunRead(({ db }) => findUpdateGatewayStop(readUpdateRuns(db, { limit: 100 })), {
    allowNativeRead: true,
  });
}

/** The parked helper continues its own run; publication keeps its sealed owner and checks. */
export async function recoverInterruptedManagedUpdate(params: {
  root: string;
  runId: string;
  owner: string;
  databaseIdentity: ManagedUpdateLeaseDatabaseIdentity;
  original: UpdateRecovery;
  originalIdentity: string;
  timeoutMs: number;
  assertCurrent: () => void;
  /** Returns the run as read by the installed runtime after post-core repair. */
  finalize: () => Promise<UpdateRunRecord | undefined>;
}) {
  const { root, assertCurrent } = params;
  const run = readManagedHandoffUpdateRun(params.runId);
  if (!run || run.status !== "running") {
    throw new Error("Interrupted updater has no current running record");
  }
  const risk =
    run.verification.recovery?.serviceRestartSafe === false
      ? run.verification.recovery.dataAtRisk
      : undefined;
  if (risk) {
    throw new Error(`keep the gateway stopped: data at risk (${risk})`);
  }
  assertCurrent();
  const anchor = resolvePackageActivationAnchor(root);
  let publication;
  let publicationOwner: ReturnType<typeof createPublicationOwner> | undefined;
  if (fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
    const journal = openPackageActivationJournal(anchor);
    const admission = await journal.readForRecovery();
    publication = admission.record;
    const { installKey, owner, ...identity } = publication.descriptor.authority;
    if (
      installKey !== root ||
      owner !== params.owner ||
      !isDeepStrictEqual(identity, params.databaseIdentity)
    ) {
      throw new Error("Package publication belongs to another update owner");
    }
    assertCurrent();
    admission.admit(assertCurrent);
    if (!isPackageActivationComplete(anchor, publication)) {
      publicationOwner = createPublicationOwner(anchor, journal, assertCurrent, publication);
      // An untouched preparation cancels activation. Once publication starts,
      // complete it forward, then let the installed post-core owner converge state.
      if (
        publication.phase === "prepared" &&
        !publication.intent &&
        !publication.publications.length
      ) {
        await publicationOwner.disarmRollback();
      } else if (
        !["aborted", "rolled-back", "retiring", "anchor-retired"].includes(publication.phase)
      ) {
        await publicationOwner.publish(true);
      }
    }
  }
  assertCurrent();
  const installed =
    params.original.serviceRestartSafe && params.original.buildId
      ? await readCurrentGitUpdateRecovery(root, params.timeoutMs)
      : {
          ...(await verifyPackageUpdateRecovery(root)),
          buildId: (await readBuiltGatewayBuildId(root)) ?? undefined,
        };
  assertCurrent();
  if (!installed.serviceRestartSafe || !installed.version) {
    throw new Error("Installed runtime identity could not be verified");
  }
  const identity = packageActivationIdentity(root, true);
  const original =
    identity === params.originalIdentity &&
    params.original.serviceRestartSafe &&
    installed.version === params.original.version &&
    (!params.original.buildId || installed.buildId === params.original.buildId);
  if (original) {
    await publicationOwner?.retireVerified();
    assertCurrent();
    return { recovery: params.original, status: "rolled-back" as const };
  }
  const candidate = publication?.descriptor.candidate;
  const expected = candidate
    ? candidate.identity === identity
      ? candidate
      : undefined
    : params.original.serviceRestartSafe && params.original.buildId && run.after.buildId
      ? run.after
      : undefined;
  if (
    !expected?.version ||
    installed.version !== expected.version ||
    ("buildId" in expected && expected.buildId && installed.buildId !== expected.buildId)
  ) {
    throw new Error("Installed runtime does not match this update's recorded candidate");
  }
  const recovery = (await params.finalize())?.verification.recovery;
  assertCurrent();
  if (
    packageActivationIdentity(root, true) !== identity ||
    (recovery?.serviceRestartSafe === false && recovery.dataAtRisk)
  ) {
    throw new Error(
      "Installed generation changed or data risk was recorded during post-core repair",
    );
  }
  await publicationOwner?.retireVerified();
  assertCurrent();
  return { recovery: installed, status: "succeeded" as const };
}
