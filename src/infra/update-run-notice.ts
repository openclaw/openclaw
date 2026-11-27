import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import {
  formatUpdateFailureFact,
  selectUpdateFailureReportSteps,
} from "./update-failure-facts-format.js";
import {
  isAcknowledgedAbandonedUpdateRun,
  isUpdateRepairRun,
  updateStepDiagnostics,
  type UpdateRunRecord,
} from "./update-run-record.js";

export type UpdateRunNoticeKind = "ack" | "parking" | "activating" | "verifying" | "finished";
type NoticeRun = Pick<UpdateRunRecord, "status" | "reason"> &
  Partial<
    Pick<UpdateRunRecord, "phase" | "before" | "after" | "verification" | "steps" | "origin">
  >;

/** Serving observation is independent of permission to restart or roll back. */
export function resolveUpdateRunVerifiedServingVersion(
  verification: UpdateRunRecord["verification"],
  observation: Pick<UpdateRunRecord["steps"][number], "failureFacts" | "exitCode"> | undefined,
): string | undefined {
  if (observation?.exitCode !== 0 || observation.failureFacts?.length) {
    return undefined;
  }
  const { recovery } = verification;
  return recovery?.serviceRestartSafe && recovery.service === "healthy"
    ? recovery.version
    : verification.versionMatch &&
        (verification.coreReady ?? verification.readyz) &&
        verification.settled
      ? verification.runningVersion
      : undefined;
}

const UPDATE_RUN_HEADLINES = new Map<UpdateRunRecord["status"], string>([
  ["succeeded", "✅ OpenClaw updated."],
  ["failed", "⚠️ OpenClaw couldn't finish updating."],
  ["rolled-back", "↩️ The update couldn't finish. OpenClaw returned to the previous version."],
  ["running", "⬆️ OpenClaw is updating."],
]);

const SKIPPED_UPDATE_RUN_HEADLINES = new Map<string | null, string>([
  ["already-current", "✅ OpenClaw is already up to date."],
  ["still-starting", "⏳ OpenClaw is installed and still starting."],
  ["gateway-readiness-unverified", "⚠️ OpenClaw is installed, but we couldn't confirm it's ready."],
  [
    "managed-service-handoff-already-running",
    "⚠️ A previous update still holds this installation.",
  ],
]);

const FAILED_PHASE_DESCRIPTIONS = new Map<string, string>([
  ["requested", "before the update started"],
  ["staging", "while preparing the update"],
  ["validating", "while validating the update"],
  ["repairing", "while repairing the installation"],
  ["activating", "while activating"],
  ["restarting", "while restarting the Gateway"],
  ["verifying", "while checking Gateway readiness"],
]);
const UNKNOWN_FAILED_PHASE = "before completion";
const UPDATE_RUN_DETAILS =
  "For details, open Settings → Updates in the OpenClaw app or run `openclaw update status` in your terminal.";

/** One factual completion summary for the CLI, update views, and final notice. */
export function renderUpdateRunSummary(
  run: NoticeRun,
  options: { manualCommand?: string } = {},
): string {
  if (
    run.steps &&
    isAcknowledgedAbandonedUpdateRun({
      status: run.status,
      reason: run.reason,
      steps: run.steps,
    })
  ) {
    return `ℹ️ OpenClaw abandoned update reconciled.\n${UPDATE_RUN_DETAILS}`;
  }
  const repairRun = run.steps ? isUpdateRepairRun({ steps: run.steps }) : false;
  const finalVersion = run.after?.version;
  const success =
    run.status === "succeeded"
      ? repairRun
        ? `OpenClaw repair completed${finalVersion ? ` for ${finalVersion}` : ""}`
        : `OpenClaw updated${finalVersion ? ` to ${finalVersion}` : ""}`
      : undefined;
  const headline = success
    ? `✅ ${success}.`
    : repairRun && run.status === "failed"
      ? `⚠️ OpenClaw repair failed: ${run.reason ?? "unknown reason"}.`
      : run.status === "running" && run.phase
        ? `⬆️ OpenClaw update in progress: ${run.phase}.`
        : run.status !== "skipped"
          ? UPDATE_RUN_HEADLINES.get(run.status)
          : (SKIPPED_UPDATE_RUN_HEADLINES.get(run.reason) ?? "ℹ️ OpenClaw wasn't updated.");
  const nextStep = options.manualCommand
    ? `Open Settings → Updates in the OpenClaw app for details. To continue, run \`${options.manualCommand}\` in your terminal.`
    : run.origin?.nextAction
      ? `Next: ${run.origin.nextAction}`
      : run.status === "failed"
        ? `Run \`openclaw triage\` to diagnose and repair the failed update. ${UPDATE_RUN_DETAILS}`
        : UPDATE_RUN_DETAILS;
  const selected = selectUpdateFailureReportSteps(
    run.steps?.filter(
      (step) =>
        step.status === "failed" || step.step === "outcome" || step.step === "diagnostic:startup",
    ) ?? [],
  );
  const failedStep =
    selected.findLast(
      (step) =>
        step.status === "failed" &&
        step.step !== "outcome" &&
        !UPDATE_RUN_PHASES.some((phase) => phase === step.step),
    ) ?? selected.findLast((step) => step.status === "failed");
  const diagnostics = new Set<string>();
  for (const step of selected) {
    const observed = updateStepDiagnostics(step);
    for (const value of [
      step.detail,
      observed.reasonDetails,
      ...observed.tails,
      ...(step.failureFacts?.map(formatUpdateFailureFact) ?? []),
    ]) {
      const text = value?.replace(/\s+/gu, " ").trim();
      if (text) {
        diagnostics.add(text);
      }
    }
  }
  const rollbackReason = run.verification?.rollbackOutcome?.reason?.replace(/\s+/gu, " ").trim();
  if (rollbackReason) {
    diagnostics.add(rollbackReason);
  }
  const detail = [...diagnostics].join(" ");
  if (failedStep && (run.status === "succeeded" || run.status === "skipped")) {
    return [
      success ? `⚠️ ${success}.` : headline,
      `Failed step: ${failedStep.step}.${detail ? ` ${detail}` : ""}`,
      run.origin?.nextAction ? `Next: ${run.origin.nextAction}` : nextStep,
    ].join("\n");
  }
  if ((run.status === "failed" || run.status === "rolled-back") && run.steps) {
    const phase =
      run.steps.findLast(
        (step) =>
          step.status === "failed" &&
          UPDATE_RUN_PHASES.some(
            (candidate) => candidate !== "finished" && candidate === step.step,
          ),
      )?.step ?? "unknown";
    const reason = run.reason ?? (repairRun ? "repair-failed" : "update-failed");
    const observation = run.steps.findLast((step) => step.step === "gateway recovery verification");
    const recovery = run.verification?.recovery;
    // The request receipt proves continued service only before activation can stop it.
    const keptServing =
      phase === "requested" &&
      !run.steps.some((step) => ["activating", "restarting", "verifying"].includes(step.step));
    const serving =
      run.verification &&
      (observation
        ? resolveUpdateRunVerifiedServingVersion(run.verification, observation)
        : recovery?.serviceRestartSafe && recovery.service === "healthy"
          ? recovery.version
          : keptServing && run.verification.serviceRunning
            ? run.verification.runningVersion
            : undefined);
    const stepName = failedStep ? ` Failed step: ${failedStep.step}.` : "";
    return [
      headline,
      ...(serving && serving === run.before?.version
        ? [
            keptServing
              ? `The current version (${serving}) is still running.`
              : `The previous version (${serving}) is still serving.`,
          ]
        : []),
      `${repairRun ? "Repair" : "Update"} failed ${FAILED_PHASE_DESCRIPTIONS.get(phase) ?? UNKNOWN_FAILED_PHASE} (${reason}).${detail ? ` ${detail}` : ""}${stepName}`,
      run.origin?.nextAction && !options.manualCommand
        ? `Next: ${run.origin.nextAction.replace(/\s+/gu, " ")}`
        : nextStep,
    ].join("\n");
  }
  const repaired = run.steps
    ?.findLast((step) => step.step === "finalize:repaired-run")
    ?.detail?.replace(/\s+/gu, " ")
    .trim();
  return [
    headline,
    ...(repairRun && repaired ? [`Repaired update: ${repaired}`] : []),
    nextStep,
  ].join("\n");
}

/** Only this renderer's terminal summaries may settle an earlier completion. */
export function isUpdateRunTerminalNoticeText(text: string): boolean {
  // Previously stored completion notices keep their original wording on replay.
  const currentText = text.replace(
    "\nFor details, open Settings → Updates in the Control UI or run `openclaw update status` in your terminal.",
    "\nFor details, open Settings → Updates in the OpenClaw app or run `openclaw update status` in your terminal.",
  );
  const lines = currentText.split("\n");
  if (
    /^Failed step: .+\./u.test(lines[1] ?? "") &&
    (lines.slice(2).join("\n").startsWith("Next: ") ||
      (lines.length === 3 && lines[2] === UPDATE_RUN_DETAILS))
  ) {
    const headline = lines[0] ?? "";
    if (/^⚠️ OpenClaw (?:updated(?: to .+)?|repair completed(?: for .+)?)\.$/u.test(headline)) {
      return true;
    }
    for (const skippedHeadline of SKIPPED_UPDATE_RUN_HEADLINES.values()) {
      if (headline === skippedHeadline) {
        return true;
      }
    }
    return headline === "ℹ️ OpenClaw wasn't updated.";
  }
  if (/^✅ OpenClaw (?:updated(?: to .+)?|repair completed(?: for .+)?)\.$/u.test(lines[0] ?? "")) {
    const advice = lines
      .slice(
        lines[0]?.startsWith("✅ OpenClaw repair completed") &&
          lines[1]?.startsWith("Repaired update: ")
          ? 2
          : 1,
      )
      .join("\n");
    return advice.startsWith("Next: ") || advice === UPDATE_RUN_DETAILS;
  }
  const repairFailure = /^⚠️ OpenClaw repair failed: .+\.$/u.test(lines[0] ?? "");
  if (
    (lines[0] === UPDATE_RUN_HEADLINES.get("failed") ||
      lines[0] === UPDATE_RUN_HEADLINES.get("rolled-back") ||
      repairFailure) &&
    lines.length >= 3 &&
    lines.length <= 4
  ) {
    const failure = (lines.length === 4 ? lines[2] : lines[1]) ?? "";
    const operation = failure.startsWith("Repair failed ") ? "Repair" : "Update";
    if (
      (lines.length === 3 ||
        /^(?:The previous version \(.+\) is still serving|The current version \(.+\) is still running)\.$/u.test(
          lines[1] ?? "",
        )) &&
      [...FAILED_PHASE_DESCRIPTIONS.values(), UNKNOWN_FAILED_PHASE].some(
        (description) =>
          failure.startsWith(`${operation} failed ${description} (`) &&
          /\)\.(?: .+)?$/u.test(failure),
      )
    ) {
      return true;
    }
  }
  if (currentText === `ℹ️ OpenClaw abandoned update reconciled.\n${UPDATE_RUN_DETAILS}`) {
    return true;
  }
  return (
    [...UPDATE_RUN_HEADLINES.keys()].some(
      (status) =>
        status !== "running" &&
        (currentText === renderUpdateRunSummary({ status, reason: null }) ||
          currentText === `${UPDATE_RUN_HEADLINES.get(status)}\n${UPDATE_RUN_DETAILS}`),
    ) ||
    [null, ...SKIPPED_UPDATE_RUN_HEADLINES.keys()].some(
      (reason) => currentText === renderUpdateRunSummary({ status: "skipped", reason }),
    )
  );
}

/** Only the current milestone may produce a conversation notice. */
export function renderUpdateRunNotice(
  run: NoticeRun & Pick<UpdateRunRecord, "phase">,
  kind: UpdateRunNoticeKind,
): string | null {
  if (kind === "finished") {
    return run.status === "running" ? null : renderUpdateRunSummary(run);
  }
  // Managed parking precedes updater staging; its notice must not advance the ledger phase.
  const noticePhase = kind === "ack" || kind === "parking" ? "requested" : kind;
  if (run.status !== "running" || run.phase !== noticePhase) {
    return null;
  }
  if (kind === "ack") {
    return "⬆️ Updating OpenClaw… You'll get a message here when it's done.";
  }
  if (kind === "activating" || kind === "parking") {
    return "⏳ Preparing to restart OpenClaw… The update is not complete yet.";
  }
  return "🔁 Checking that OpenClaw is ready…";
}
