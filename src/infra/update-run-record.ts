import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { z } from "zod";
import type { UpdateRunRecord as PublicUpdateRunRecord } from "../../packages/gateway-protocol/src/schema/update-runs.js";
import { LEGACY_UPDATE_RUN_EXPIRED_REASON } from "./update-run-legacy-expiry.js";
import type { UpdateRunRecoveryState } from "./update-run-recovery-state.js";
import type { UpdateRunRecordSchema } from "./update-run-schema.js";
import type { UpdateStepResult } from "./update-step-result.js";

export function updateStepDiagnostics(
  step: Pick<UpdateStepResult, "failureFacts" | "stdoutTail" | "stderrTail">,
): { tails: string[]; reasonDetails?: string } {
  const stderr = step.stderrTail ?? "";
  const tails = [step.stdoutTail ?? "", stderr];
  if (
    !step.failureFacts?.length ||
    !/^\[openclaw\] (?:The CLI command failed\.|Reason: )/mu.test(stderr)
  ) {
    return { tails };
  }
  const messages = new Set(
    step.failureFacts.flatMap((fact) => (fact.message ? [fact.message] : [])),
  );
  const reason =
    /(?:^|\n)\[openclaw\] Reason: ([\s\S]*?)(?=\n\[openclaw\] (?:Debug: |Stack:|Try: |Help: )|$)/u.exec(
      stderr,
    )?.[1];
  const reasonDetails = reason
    ?.split(/\r?\n/u)
    .filter((line) => !messages.has(line.trim()))
    .join("; ")
    .trim();
  const filtered = tails.map((output) => {
    let tail = output;
    for (const message of messages) {
      const envelope = { ok: false, error: { type: "cli_error", message } };
      tail = tail
        .replaceAll(JSON.stringify(envelope), "")
        .replaceAll(JSON.stringify(envelope, null, 2), "");
    }
    return tail
      .split(/\r?\n/u)
      .filter((line) => {
        if (/^\[openclaw\] (?:The CLI command failed\.$|Debug: |Try: |Help: )/u.test(line)) {
          return false;
        }
        return !messages.has(line.replace(/^\[openclaw\] Reason: /u, "").trim());
      })
      .join("\n");
  });
  return { tails: filtered, reasonDetails };
}

/** A bounded diagnostic excerpt for a failed update step, never its command log or cwd. */
export function summarizeUpdateStepFailure(
  step: Pick<
    UpdateStepResult,
    "name" | "exitCode" | "termination" | "stdoutTail" | "stderrTail" | "failureFacts"
  >,
): string {
  const diagnostics = updateStepDiagnostics(step);
  // Schema refusals lead with the cause, followed by documentation and generic recovery advice.
  const excerpts =
    step.name === "database-schema-preflight"
      ? [(step.stderrTail?.trim() || step.stdoutTail?.trim())?.split(/\r?\n/u)[0]]
      : diagnostics.tails.map((tail, index) => {
          const lines = tail.trim().split(/\r?\n/u);
          const lastLine =
            lines.findLast(
              (line) =>
                line.trim() && !line.trim().startsWith("Installation recovery is unverified;"),
            ) ??
            lines.at(-1) ??
            "";
          const cause =
            index === 1
              ? diagnostics.reasonDetails ||
                step.failureFacts?.map((fact) => fact.message?.trim() || fact.code).join("; ") ||
                lastLine
              : lastLine;
          // Recovery advice must not displace the initiating error inside this budget.
          const causeOnly = cause.split(/(?<=\.)\s+Installation recovery is unverified;/u)[0] ?? "";
          if (index !== 1 || !diagnostics.reasonDetails || causeOnly.includes(lastLine)) {
            return truncateUtf16Safe(causeOnly, 120);
          }
          // A distinct terminal outcome shares the budget, but cannot crowd out the cause.
          const outcome = truncateUtf16Safe(lastLine, 60);
          return [truncateUtf16Safe(causeOnly, 120 - outcome.length - 2), outcome].join("; ");
        });
  return truncateUtf16Safe(
    [step.termination ?? `Exit code: ${step.exitCode ?? "unknown"}`, ...excerpts]
      .filter(Boolean)
      .join("; "),
    300,
  );
}

export type UpdateRunRecord = z.infer<typeof UpdateRunRecordSchema>;

/** Operational capture receipts stay in the private ledger, not status or diagnostic exports. */
export function toPublicUpdateRun(record: UpdateRunRecord): PublicUpdateRunRecord {
  const origin = { ...record.origin };
  delete origin.updateRecoveryCapture;
  return { ...record, origin };
}
export type UpdateRunPhase = UpdateRunRecord["phase"];
export type UpdateRunStep = UpdateRunRecord["steps"][number];

// Record recovery depends on legacy expiry for its reason; both use the leaf recovery-state type.
export function isAbandonedUpdateRun(
  record: Pick<UpdateRunRecoveryState, "status" | "reason">,
): boolean {
  return (
    record.status === "failed" &&
    (record.reason === "abandoned" || record.reason === LEGACY_UPDATE_RUN_EXPIRED_REASON)
  );
}

export function isAcknowledgedAbandonedUpdateRun(
  record: Pick<UpdateRunRecoveryState, "status" | "reason" | "steps">,
): boolean {
  return (
    isAbandonedUpdateRun(record) &&
    record.steps.some(
      (step) => step.step === "reconcile:acknowledged" && step.status === "completed",
    )
  );
}

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
  record.reason = result.reason ?? (result.status === "failed" ? record.reason : null);
  record.finishedAtMs = now;
  record.after = { ...record.after, ...result.after };
  record.downtimeMs = result.downtimeMs ?? record.downtimeMs;
}

/** Only the package-owner refusal before update work can bypass repair finalization. */
export function isUnacknowledgedPackageOwnerRefusal(record: UpdateRunRecord): boolean {
  const requested = record.steps.find((step) => step.step === "requested");
  return (
    record.trigger === "cli" &&
    record.phase === "finished" &&
    record.target.kind !== "git" &&
    !Object.keys(record.after).length &&
    !Object.keys(record.verification).length &&
    !record.repair.length &&
    record.steps.every(
      (step) =>
        step.step === "requested" ||
        (step.step === "driver:adopted" && step.status === "completed") ||
        (step.step === "installation-inspection" && step.status === "skipped"),
    ) &&
    ((record.status === "skipped" &&
      record.reason === "unmanaged-package-install" &&
      requested?.status === "skipped") ||
      // 2026.9.4 threw this exact error before it could record a structured refusal.
      (record.status === "failed" &&
        record.reason === "update-failed" &&
        requested?.status === "failed" &&
        requested.detail?.startsWith(
          "Update refused: package manager owner is unknown; no changes were made.",
        ) === true))
  );
}

export type UpdateFetchFailure = {
  reason: "fetch-failed";
  failedAtMs: number;
  detail: string;
  runId: string;
};
