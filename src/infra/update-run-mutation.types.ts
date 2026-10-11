import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";
import type { createUpdateRun } from "./update-run-ledger.js";
import type { UpdateRunPhase, UpdateRunRecord, UpdateRunStep } from "./update-run-record.js";
import type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";
import type { finishUpdateRun, UpdateRunDiagnostics } from "./update-run-write.js";

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
  | { kind: "bookkeeping-skipped" }
  | { kind: "recovery-required"; recovery: UpdateRecoveryRecord };

export type UpdateRunWriteOperations = {
  "updateRuns.create": {
    input: UpdateRunWriteInput & { run: Parameters<typeof createUpdateRun>[0] };
    output: UpdateRunWriteResult;
  };
  "updateRuns.finish": {
    input: UpdateRunWriteInput & { result: Parameters<typeof finishUpdateRun>[1] };
    output: UpdateRunWriteResult;
  };
  "updateRuns.recordVerification": {
    input: UpdateRunWriteInput & {
      verification: UpdateRunRecord["verification"];
      onlyIfRunning?: true;
    };
    output: UpdateRunWriteResult;
  };
  "updateRuns.recordDiagnostics": {
    input: UpdateRunWriteInput & { diagnostics: UpdateRunDiagnostics; preserveRecovery?: true };
    output: UpdateRunWriteResult;
  };
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

export type UpdateRunWriteCommand = SqliteWorkerCommand<UpdateRunWriteOperations>;
