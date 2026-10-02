import type { UpdateRunPhase, UpdateRunRecord, UpdateRunStep } from "./update-run-record.js";
import type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";

export type UpdateRunRedactionFacts = {
  effectiveHome: string;
  home?: string;
  userProfile?: string;
  configPath?: string;
};

export type UpdateRunPatch = Partial<
  Pick<UpdateRunRecord, "origin" | "target" | "before" | "after" | "trigger">
>;

export type UpdateRunPhasePatch = UpdateRunPatch & { step?: UpdateRunStep };

type UpdateRunWriteInput = {
  runId: string;
  redactionFacts: UpdateRunRedactionFacts;
  requireNoRecovery?: true;
  busyTimeoutMs?: number;
  redactPaths?: readonly string[];
};

type UpdateRunWriteResult =
  | { kind: "recorded"; record: UpdateRunRecord }
  | { kind: "recovery-required"; recovery: UpdateRecoveryRecord };

export type UpdateRunWriteOperations = {
  "updateRuns.recordStep": {
    input: UpdateRunWriteInput & {
      step: UpdateRunStep & { reason?: string };
    };
    output: UpdateRunWriteResult;
  };
  "updateRuns.recordPhase": {
    input: UpdateRunWriteInput & { phase: UpdateRunPhase; patch: UpdateRunPhasePatch };
    output: UpdateRunWriteResult;
  };
};

export type UpdateRunWriteCommand = {
  [Type in keyof UpdateRunWriteOperations]: {
    type: Type;
    input: UpdateRunWriteOperations[Type]["input"];
  };
}[keyof UpdateRunWriteOperations];
