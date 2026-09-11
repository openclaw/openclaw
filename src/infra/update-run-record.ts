import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { z } from "zod";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import {
  inspectUpdateRunDriver,
  readUpdateRunDriver,
  sameUpdateRunDriver,
} from "./update-run-driver.js";
import type { UpdateRunRecordSchema } from "./update-run-schema.js";
import type { UpdateStepResult, UpdateRunResult } from "./update-runner-types.js";

/** A bounded diagnostic excerpt for a failed update step, never its command log or cwd. */
export function summarizeUpdateStepFailure(
  step: Pick<UpdateStepResult, "exitCode" | "termination" | "stdoutTail" | "stderrTail">,
): string {
  return truncateUtf16Safe(
    [
      step.termination ?? `Exit code: ${step.exitCode ?? "unknown"}`,
      ...[step.stdoutTail, step.stderrTail].map((tail) =>
        sliceUtf16Safe(tail?.trim().split(/\r?\n/u).at(-1) ?? "", -120),
      ),
    ]
      .filter(Boolean)
      .join("; "),
    300,
  );
}

export type UpdateRunRecord = z.infer<typeof UpdateRunRecordSchema>;
export type UpdateRunPhase = UpdateRunRecord["phase"];
export type UpdateRunStep = UpdateRunRecord["steps"][number];

export type FinishUpdateRunResult = {
  status: Exclude<UpdateRunRecord["status"], "running">;
  reason?: string;
  after?: UpdateRunRecord["after"];
  downtimeMs?: number;
};

export function finishUpdateRunRecord(
  record: UpdateRunRecord,
  result: FinishUpdateRunResult,
): void {
  // CLI and the new Gateway may finish together. The first durable terminal outcome wins.
  if (record.status !== "running") {
    return;
  }
  const now = Date.now();
  // A thrown command or interrupted updater can miss its completion callback.
  // Terminal runs cannot retain live steps after their lifecycle closes.
  for (const step of record.steps) {
    if (step.step === record.phase || step.status === "in_progress") {
      step.status =
        result.status === "failed"
          ? "failed"
          : result.status === "skipped"
            ? "skipped"
            : "completed";
      step.endedAtMs = now;
    }
  }
  record.status = result.status;
  record.phase = "finished";
  record.reason = result.reason ?? null;
  record.finishedAtMs = now;
  record.after = { ...record.after, ...result.after };
  record.downtimeMs = result.downtimeMs ?? record.downtimeMs;
}

export type UpdateFetchFailure = {
  reason: "fetch-failed";
  failedAtMs: number;
  detail: string;
  runId: string;
};

export const UNPROTECTED_GATEWAY_UPDATE_ADVISORY =
  "This Gateway-initiated update is not protected by a recovery capture. Run `openclaw update` from a terminal for a protected update.";

export function requireUnprotectedGatewayUpdate(record: UpdateRunRecord | undefined) {
  const declaration = record?.origin.unprotectedGatewayUpdate;
  if (
    !record ||
    !declaration ||
    record.status !== "running" ||
    record.trigger === "cli" ||
    record.target.kind !== "git" ||
    record.origin.updateRecoveryCapture ||
    inspectUpdateRunDriver(declaration.owner) !== "alive"
  ) {
    throw new Error(
      "Unprotected Gateway update requires its live, explicitly declared parent run.",
    );
  }
  return { record, declaration };
}

/** Only the serving RPC driver may declare this intentionally unprotected update. */
export function declareUnprotectedGatewayUpdateRecord(record: UpdateRunRecord): void {
  const owner = readUpdateRunDriver();
  if (
    !owner ||
    !record.origin.driver ||
    !sameUpdateRunDriver(record.origin.driver, owner) ||
    record.status !== "running" ||
    record.trigger === "cli" ||
    record.target.kind !== "git" ||
    record.verification.pid !== owner.pid ||
    record.verification.serviceRunning !== true ||
    record.origin.updateRecoveryCapture ||
    record.origin.unprotectedGatewayUpdate
  ) {
    throw new Error("Only the admitted Gateway driver may declare an unprotected Git update.");
  }
  record.origin.unprotectedGatewayUpdate = { owner };
  record.origin.nextAction = UNPROTECTED_GATEWAY_UPDATE_ADVISORY;
}

export function bindUnprotectedGatewayUpdateFinalizerRecord(record: UpdateRunRecord): void {
  const self = readUpdateRunDriver();
  const directParent = readUpdateRunDriver(process.ppid);
  const { declaration } = requireUnprotectedGatewayUpdate(record);
  if (
    !self ||
    !directParent ||
    !sameUpdateRunDriver(declaration.owner, directParent) ||
    !record.origin.driver ||
    !sameUpdateRunDriver(record.origin.driver, directParent) ||
    (declaration.finalizer && !sameUpdateRunDriver(declaration.finalizer, self))
  ) {
    throw new Error("Unprotected Gateway finalizer is not the declared owner's child.");
  }
  record.origin.unprotectedGatewayUpdate = { ...declaration, finalizer: self };
}

export function withUnprotectedGatewayUpdateAdvisory(result: UpdateRunResult): UpdateRunResult {
  return {
    ...result,
    steps: [
      ...result.steps,
      {
        name: "unprotected Gateway update",
        command: "openclaw update",
        cwd: result.root ?? process.cwd(),
        durationMs: 0,
        exitCode: 0,
        advisory: { kind: "recoverable-maintenance", message: UNPROTECTED_GATEWAY_UPDATE_ADVISORY },
      },
    ],
  };
}

export function upsertUpdateRunStep(record: UpdateRunRecord, step: UpdateRunStep): void {
  const index = record.steps.findIndex((existing) => existing.step === step.step);
  if (index >= 0) {
    record.steps[index] = { ...record.steps[index], ...step };
  } else {
    record.steps.push(step);
  }
  while (record.steps.length > 128) {
    const disposable = record.steps.findIndex((entry) => !isRetainedStep(entry));
    if (disposable < 0) {
      throw new Error("Update run retained steps exceed the step limit");
    }
    record.steps.splice(disposable, 1);
  }
}

const RETAINED_STEP_NAMES = [
  ...UPDATE_RUN_PHASES,
  "notice:ack",
  "notice:activating",
  "notice:verifying",
  "previous generation restoration",
  "post-update verification",
  "driver:adopted",
  "driver:identity-unavailable",
  "reconcile:abandoned",
  "reconcile:superseded",
  "reconcile:acknowledged",
];
export function isRetainedStep(item: unknown): boolean {
  return (
    isRecord(item) &&
    typeof item.step === "string" &&
    (item.step.startsWith("finalize:") || RETAINED_STEP_NAMES.some((name) => name === item.step))
  );
}
