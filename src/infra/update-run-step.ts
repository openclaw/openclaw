import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatUpdateDoctorConfigChange } from "./update-doctor-config.js";
import { UPDATE_RUN_DIAGNOSTIC_LIMIT, UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";
import { summarizeUpdateStepFailure, type UpdateRunStep } from "./update-run-record.js";
import type { UpdateRunResult } from "./update-runner-types.js";
import type { UpdateSnapshotCapacity } from "./update-snapshot-capacity.js";
import type { UpdateStepResult } from "./update-step-result.js";

type ResultStep = Omit<UpdateStepResult, "command" | "cwd" | "durationMs" | "recoverySteps">;

/** Physical process success does not erase a failed inspection or incomplete termination. */
export function isFailedUpdateStep(
  step: Pick<
    UpdateStepResult,
    "exitCode" | "advisory" | "failureFacts" | "termination" | "killed" | "outputLimitExceeded"
  >,
): boolean {
  return (
    !step.advisory &&
    (step.exitCode !== 0 ||
      Boolean(step.failureFacts?.length || step.killed || step.outputLimitExceeded) ||
      (step.termination !== undefined && step.termination !== "exit"))
  );
}

export function isUpdateGatewayReadinessPending(result: UpdateRunResult): boolean {
  const step = result.steps.findLast(
    (entry) =>
      entry.name === "gateway verification" ||
      entry.name === "rollback gateway verification" ||
      entry.name === "gateway recovery verification",
  );
  return step?.termination === "timeout" && step.advisory?.kind === "recoverable-maintenance";
}

/** Preserve producer-classified diagnostics without turning successful inventory into warnings. */
export function updateRunStepsFromResultStep(step: ResultStep): UpdateRunStep[] {
  const text = (value: string) => truncateUtf16Safe(value, UPDATE_RUN_TEXT_LIMIT);
  const failed = isFailedUpdateStep(step);
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
      status: failed ? "failed" : "completed",
      exitCode: step.exitCode,
      // A completed retry replaces diagnostics from the previous attempt with the same ID.
      failureFacts:
        step.failureFacts?.length && !step.advisory ? step.failureFacts.slice(0, 5) : undefined,
      configWriteRefusal,
      snapshotCapacity,
      detail:
        failed || step.exitCode !== 0
          ? text(step.advisory?.message ?? summarizeUpdateStepFailure(step))
          : undefined,
    },
    ...(step.doctorLintFindings
      ? [
          {
            step: text(`finalize:doctor-lint:${step.name}`),
            status: "completed" as const,
            detail: formatUpdateDoctorLintReceipt(step),
          },
        ]
      : []),
    ...[
      { kind: "warning", messages: warnings },
      { kind: "diagnostic", messages: step.diagnostics ?? [] },
    ].flatMap(({ kind, messages }) =>
      messages.slice(0, UPDATE_RUN_DIAGNOSTIC_LIMIT).map((detail, index) => ({
        step: text(`${kind}:${step.name}${index === 0 ? "" : `:${index + 1}`}`),
        status: "completed" as const,
        detail: text(detail),
      })),
    ),
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

export function updateRunWarningMessages(
  steps: readonly UpdateRunStep[],
  maxMessages?: number,
): string[] {
  const messages = steps.flatMap((step) =>
    (step.step === "reconcile:settle" ||
      (step.status === "completed" && step.step.startsWith("warning:"))) &&
    step.detail
      ? [step.detail]
      : [],
  );
  if (maxMessages === undefined) {
    return messages;
  }
  // The operator's restart command must survive later advisory Doctor warnings.
  const serviceWarning = steps.findLast(
    (step) => step.step === "warning:managed-service-reconciliation" && step.status === "completed",
  )?.detail;
  return (
    serviceWarning
      ? [
          serviceWarning,
          ...messages.filter((message) => message !== serviceWarning).slice(1 - maxMessages),
        ]
      : messages.slice(-maxMessages)
  ).slice(0, maxMessages);
}

/** Shared bounded receipt for history and rollback-readable diagnostics. */
export function formatUpdateDoctorLintReceipt(
  step: Pick<
    UpdateStepResult,
    "exitCode" | "termination" | "killed" | "outputLimitExceeded" | "doctorLintFindings"
  > & { signal?: string | null },
  maxBytes = UPDATE_RUN_TEXT_LIMIT,
): string {
  const errors: Array<{ checkId: string; message: string }> = [];
  const lint = {
    exitCode: step.exitCode,
    termination: step.termination,
    signal: step.signal,
    killed: step.killed,
    outputLimitExceeded: step.outputLimitExceeded,
    counts: { error: 0, warning: 0, info: 0 },
    errors,
    omitted: 0,
  };
  for (const finding of step.doctorLintFindings ?? []) {
    const severity =
      finding.severity === "warning" || finding.severity === "info" ? finding.severity : "error";
    lint.counts[severity]++;
    if (severity === "error") {
      lint.errors.push({
        checkId: truncateUtf16Safe(finding.checkId, 128),
        message: truncateUtf16Safe(
          [finding.requirement, finding.message].filter(Boolean).join(": "),
          200,
        ),
      });
    }
  }
  const utf8 = new TextEncoder();
  while (
    utf8.encode(JSON.stringify(JSON.stringify(lint))).length > maxBytes &&
    lint.errors.length
  ) {
    lint.errors.pop();
    lint.omitted++;
  }
  return JSON.stringify(lint);
}
