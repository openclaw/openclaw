import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatUpdateDoctorConfigChange } from "./update-doctor-config.js";
import { UPDATE_RUN_DIAGNOSTIC_LIMIT, UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";
import { summarizeUpdateStepFailure, type UpdateRunStep } from "./update-run-record.js";
import type { UpdateStepResult } from "./update-runner-types.js";
import type { UpdateSnapshotCapacity } from "./update-snapshot-capacity.js";

type ResultStep = Pick<
  UpdateStepResult,
  | "name"
  | "exitCode"
  | "advisory"
  | "warnings"
  | "termination"
  | "stdoutTail"
  | "stderrTail"
  | "failureFacts"
  | "configChanges"
  | "configWriteRefusal"
  | "snapshotCapacity"
>;

/** Warning rows preserve producer-classified advisories in the existing diagnostic ledger. */
export function updateRunStepsFromResultStep(step: ResultStep): UpdateRunStep[] {
  const text = (value: string) => truncateUtf16Safe(value, UPDATE_RUN_TEXT_LIMIT);
  const refusal = step.configWriteRefusal;
  const configWriteRefusal = refusal
    ? {
        reason: text(refusal.reason),
        message: text(refusal.message),
        keys: refusal.keys.slice(0, UPDATE_RUN_DIAGNOSTIC_LIMIT).map(text),
      }
    : undefined;
  const capacity = step.snapshotCapacity;
  const snapshotCapacity = capacity
    ? {
        ...capacity,
        candidates: capacity.candidates.slice(0, 3).map((candidate) => {
          const copied: UpdateSnapshotCapacity["candidates"][number] = {
            kind: candidate.kind,
            availableBytes: candidate.availableBytes,
            directory: text(candidate.directory),
          };
          if (candidate.allocationError) {
            copied.allocationError = text(candidate.allocationError);
          }
          return copied;
        }),
        selection: capacity.selection
          ? { ...capacity.selection, directory: text(capacity.selection.directory) }
          : null,
      }
    : undefined;
  const warnings = step.warnings?.length
    ? step.warnings
    : step.advisory
      ? [step.advisory.message]
      : [];
  return [
    {
      step: text(step.name),
      status: step.exitCode === 0 || step.advisory ? "completed" : "failed",
      ...(step.failureFacts?.length && !step.advisory
        ? { failureFacts: step.failureFacts.slice(0, 5) }
        : {}),
      ...(configWriteRefusal ? { configWriteRefusal } : {}),
      ...(snapshotCapacity ? { snapshotCapacity } : {}),
      ...(step.exitCode !== 0
        ? { detail: text(step.advisory?.message ?? summarizeUpdateStepFailure(step)) }
        : {}),
    },
    ...warnings.slice(0, UPDATE_RUN_DIAGNOSTIC_LIMIT).map((detail, index) => ({
      step: text(`warning:${step.name}${index === 0 ? "" : `:${index + 1}`}`),
      status: "completed" as const,
      detail: text(detail),
    })),
    ...(step.configChanges ?? []).slice(0, UPDATE_RUN_DIAGNOSTIC_LIMIT).map((change, index) => {
      const configChange =
        change.kind === "key"
          ? { kind: change.kind, key: text(change.key) }
          : { kind: change.kind, message: text(change.message) };
      return {
        step: text(`doctor-config:${step.name}:${index}`),
        status: "completed" as const,
        detail: text(formatUpdateDoctorConfigChange(configChange)),
        configChange,
      };
    }),
  ];
}

export function updateRunWarningMessages(steps: readonly UpdateRunStep[]): string[] {
  return steps.flatMap((step) =>
    step.status === "completed" && step.step.startsWith("warning:") && step.detail
      ? [step.detail]
      : [],
  );
}
