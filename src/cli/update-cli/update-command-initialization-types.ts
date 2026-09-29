import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import type { UpdateRecoveryBaselineRef } from "../../infra/update-recovery-baseline-capture.js";

export type UpdateInitializationAdmission = {
  env: NodeJS.ProcessEnv;
  runId: string;
  originalRecoveryCapture?: UpdateRecoveryBaselineRef;
  databasePath: string;
  configPath: string;
  target?: {
    configSnapshot: ConfigFileSnapshot;
    legacyConfigPlan?: LegacyConfigUpdatePlan;
    updateInstallKind?: "git" | "package" | "unknown";
  };
};
