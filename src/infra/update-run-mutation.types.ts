import type { UpdateRunRecord, UpdateRunStep } from "./update-run-record.js";
import type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";

export type UpdateRunRedactionFacts = {
  effectiveHome: string;
  home?: string;
  userProfile?: string;
  configPath?: string;
};

export type UpdateRunStepWriteOperations = {
  "updateRuns.recordStep": {
    input: {
      runId: string;
      step: UpdateRunStep & { reason?: string };
      redactionFacts: UpdateRunRedactionFacts;
      requireNoRecovery?: true;
      busyTimeoutMs?: number;
      redactPaths?: readonly string[];
    };
    output:
      | { kind: "recorded"; record: UpdateRunRecord }
      | { kind: "recovery-required"; recovery: UpdateRecoveryRecord };
  };
};
