/** Fenced cleanup for non-authoritative update-report body artifacts. */
import { randomUUID } from "node:crypto";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  claimUpdateFailureReportArtifactSweep,
  hasUpdateFailureReportArtifactSweepLease,
  releaseUpdateFailureReportArtifactSweep,
  type UpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import {
  bindSavedReportArtifact,
  listRetiredUpdateFailureReportArtifacts,
  removeRetiredUpdateFailureReportArtifacts,
} from "./update-failure-report-artifact.js";
import { retryUpdateReportStateWrite } from "./update-failure-report-precreate.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";

export type UpdateFailureReportSweepHooks = {
  beforeList?: () => Promise<void>;
  listCandidates?: typeof listRetiredUpdateFailureReportArtifacts;
};

export type UpdateFailureReportSweepReceipt = Pick<
  UpdateFailureReportReceipt,
  "artifactSweep" | "previewDigest" | "replacementReady" | "reservationId"
>;

/** A current lease authorizes captured retired paths; successor reservation paths are never reused. */
export async function cleanRetiredUpdateFailureReportArtifacts(
  prepared: PreparedUpdateFailureReport,
  receipt: UpdateFailureReportSweepReceipt,
  stateEnv: NodeJS.ProcessEnv,
  keepCurrent = true,
  hooks: UpdateFailureReportSweepHooks = {},
  context = captureOpenClawStateWorkerContext({ env: stateEnv }),
): Promise<boolean> {
  const sweepOwnerId = randomUUID();
  const sweepGeneration = randomUUID();
  const claimed = await retryUpdateReportStateWrite(() =>
    claimUpdateFailureReportArtifactSweep(
      prepared.attemptId,
      receipt.reservationId,
      sweepOwnerId,
      sweepGeneration,
      stateEnv,
      context,
    ),
  );
  if (!claimed) {
    return false;
  }
  const keep =
    !keepCurrent || receipt.replacementReady
      ? undefined
      : bindSavedReportArtifact(prepared, receipt.reservationId, receipt.previewDigest);
  const hasSweepLease = () =>
    hasUpdateFailureReportArtifactSweepLease(
      prepared.attemptId,
      receipt.reservationId,
      sweepOwnerId,
      sweepGeneration,
      stateEnv,
      context,
    );
  let swept = false;
  try {
    await hooks.beforeList?.();
    if (!(await hasSweepLease())) {
      return false;
    }
    const candidates = await (hooks.listCandidates ?? listRetiredUpdateFailureReportArtifacts)(
      prepared,
      keep,
    );
    if (!(await hasSweepLease())) {
      return false;
    }
    // A later takeover cannot add its new reservation paths to this already-captured set.
    context.admission.assertCurrent();
    await removeRetiredUpdateFailureReportArtifacts(candidates);
    swept = true;
  } finally {
    const released = await retryUpdateReportStateWrite(() =>
      releaseUpdateFailureReportArtifactSweep(
        prepared.attemptId,
        receipt.reservationId,
        sweepOwnerId,
        sweepGeneration,
        stateEnv,
        context,
      ),
    );
    swept &&= released;
  }
  return swept;
}
