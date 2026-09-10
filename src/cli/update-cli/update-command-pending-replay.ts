import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import type { UpdateCommandOptions } from "./shared.js";
import { resolveUpdateCommandAdmissionEnv } from "./update-command-run.js";

/** Retained full-state records are read-only. Admission must precede executor,
 * ledger, native-service or package mutation, including a missing canonical DB. */
export async function resumePendingUpdateCommand(params: {
  opts: UpdateCommandOptions;
  root: string;
  invocationCwd?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  if (params.opts.dryRun || params.opts.run || params.opts.recovery) {
    return false;
  }
  const env = await resolveUpdateCommandAdmissionEnv(params);
  await assertUpdateRecoveryAdmission({ env });
  return false;
}
