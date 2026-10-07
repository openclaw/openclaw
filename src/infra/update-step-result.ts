import type { UpdateRecoveryStep } from "../shared/update-outcome.js";
import type {
  UpdateDoctorConfigChange,
  UpdateDoctorConfigWriteRefusal,
} from "./update-doctor-config.js";
import type { UpdateDoctorLintFinding } from "./update-doctor-lint-schema.js";
import type { PackageUpdateStepAdvisory } from "./update-doctor-result.js";
import type { UpdateFailureFact } from "./update-failure-facts.js";
import type { UpdateSnapshotCapacity } from "./update-snapshot-capacity.js";

type UpdateStepAdvisory =
  | PackageUpdateStepAdvisory
  | { kind: "candidate-runtime-unavailable" | "recoverable-maintenance"; message: string };

export type UpdateStepResult = {
  /** Stable public identifier; released recovery keys retain their persisted spelling. */
  name: string;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  outputLimitExceeded?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
  advisory?: UpdateStepAdvisory;
  /** Complete owner-classified warnings when one step reports several outcomes. */
  warnings?: string[];
  /** Owner-selected informational messages, retained separately from warnings and raw output. */
  diagnostics?: string[];
  /** Suggested operator actions, distinct from executed update steps. */
  recoverySteps?: readonly UpdateRecoveryStep[];
  failureFacts?: UpdateFailureFact[];
  doctorLintFindings?: UpdateDoctorLintFinding[];
  configChanges?: UpdateDoctorConfigChange[];
  configWriteRefusal?: UpdateDoctorConfigWriteRefusal;
  snapshotCapacity?: UpdateSnapshotCapacity;
};
