import { hashConfigRaw } from "../../config/io.read-helpers.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import type { UpdateDoctorConfigChange } from "../../infra/update-doctor-config-format.js";
import type { UpdateRecoveryBaselineRef } from "../../infra/update-recovery-baseline-capture.js";
import type { UpdateRequester } from "../../infra/update-requester-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";

export type PackageDoctorContext = {
  runId: string;
  executorFence: UpdateRecoveryFence;
  requester?: Readonly<UpdateRequester>;
  inputHash: string;
  changes: UpdateDoctorConfigChange[];
  databaseBackup?: UpdateDatabaseBackup;
  originalRecoveryCapture?: UpdateRecoveryBaselineRef;
  assertCurrent: () => void;
  assertBoundChildCurrent: () => void;
  onStateHandoff?: () => void;
};

export function preparePackageDoctorContext({
  capable,
  runId,
  executorFence,
  inputHash,
  ...context
}: Omit<PackageDoctorContext, "runId" | "executorFence" | "inputHash"> & {
  capable: boolean;
  runId?: string;
  executorFence?: UpdateRecoveryFence;
  inputHash?: string | null;
}) {
  context.assertCurrent();
  if (!capable) {
    return undefined;
  }
  if (!runId || !executorFence || inputHash === undefined) {
    throw new Error("Validated Doctor requires its live update executor and captured config hash.");
  }
  return {
    ...context,
    runId,
    executorFence,
    inputHash: inputHash ?? hashConfigRaw(null),
  };
}
