/** Cleanup for non-authoritative update-report body artifacts. */
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  readUpdateFailureReportReceipt,
  type UpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import {
  bindSavedReportArtifact,
  listRetiredUpdateFailureReportArtifacts,
  removeRetiredUpdateFailureReportArtifacts,
} from "./update-failure-report-artifact.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";

export type UpdateFailureReportSweepReceipt = Pick<
  UpdateFailureReportReceipt,
  "artifactSweep" | "previewDigest" | "replacementReady" | "reservationId"
>;

export async function cleanRetiredUpdateFailureReportArtifacts(
  prepared: PreparedUpdateFailureReport,
  receipt: UpdateFailureReportSweepReceipt,
  stateEnv: NodeJS.ProcessEnv,
  keepCurrent = true,
  context = captureOpenClawStateWorkerContext({ env: stateEnv }),
): Promise<void> {
  const candidates = await listRetiredUpdateFailureReportArtifacts(prepared);
  const current = await readUpdateFailureReportReceipt(prepared.attemptId, stateEnv, context);
  const keep = [
    ...(keepCurrent && !receipt.replacementReady ? [receipt] : []),
    ...(current &&
    current.status !== "created" &&
    current.cleanup !== "pending" &&
    !current.replacementReady
      ? [current]
      : []),
  ];
  const keepPaths = new Set(
    keep.flatMap((owner) => {
      const { savedReportPath } = bindSavedReportArtifact(
        prepared,
        owner.reservationId,
        owner.previewDigest,
      );
      return [savedReportPath, `${savedReportPath}.pending`];
    }),
  );
  // Protect a successor already listed; later reservations use names outside this captured set.
  context.admission.assertCurrent();
  await removeRetiredUpdateFailureReportArtifacts(
    candidates.filter((candidate) => !keepPaths.has(candidate)),
  );
}
