import type { UpdateRecoveryBaselineRef } from "../../infra/update-recovery-baseline-capture.js";

export type UpdateInitializationAdmission = {
  env: NodeJS.ProcessEnv;
  runId: string;
  originalRecoveryCapture?: UpdateRecoveryBaselineRef;
};
