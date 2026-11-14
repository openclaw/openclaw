import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { resolveUpdateRunVerifiedServingVersion } from "./update-run-report.js";

export type UpdateRunNoticeKind = "ack" | "parking" | "activating" | "verifying" | "finished";
type NoticeRun = Pick<UpdateRunRecord, "status" | "reason"> &
  Partial<Pick<UpdateRunRecord, "before" | "verification" | "steps" | "origin">>;

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

/** Chat shows the outcome; the update views keep diagnostics and recovery instructions. */
export function renderUpdateRunSummary(
  run: NoticeRun,
  options: { manualCommand?: string } = {},
): string {
  const headline =
    run.status !== "skipped"
      ? UPDATE_RUN_HEADLINES.get(run.status)
      : (SKIPPED_UPDATE_RUN_HEADLINES.get(run.reason) ?? "ℹ️ OpenClaw wasn't updated.");
  const nextStep = options.manualCommand
    ? `Open Settings → Updates in the Control UI for details. To continue, run \`${options.manualCommand}\` in your terminal.`
    : "For details, open Settings → Updates in the Control UI or run `openclaw update status` in your terminal.";
  if (run.status === "failed" && run.steps) {
    const phase =
      run.steps.findLast(
        (step) =>
          step.status === "failed" &&
          UPDATE_RUN_PHASES.some(
            (candidate) => candidate !== "finished" && candidate === step.step,
          ),
      )?.step ?? "unknown";
    const reason = run.reason ?? "update-failed";
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
    return [
      headline,
      ...(serving && serving === run.before?.version
        ? [
            keptServing
              ? `The current version (${serving}) is still running.`
              : `The previous version (${serving}) is still serving.`,
          ]
        : []),
      `Update failed ${FAILED_PHASE_DESCRIPTIONS.get(phase) ?? UNKNOWN_FAILED_PHASE} (${reason}).`,
      run.origin?.nextAction && !options.manualCommand
        ? `Next: ${run.origin.nextAction.replace(/\s+/gu, " ")}`
        : nextStep,
    ].join("\n");
  }
  return `${headline}\n${nextStep}`;
}

/** Only this renderer's terminal summaries may settle an earlier completion. */
export function isUpdateRunTerminalNoticeText(text: string): boolean {
  const lines = text.split("\n");
  if (lines[0] === UPDATE_RUN_HEADLINES.get("failed") && lines.length >= 3 && lines.length <= 4) {
    const failure = (lines.length === 4 ? lines[2] : lines[1]) ?? "";
    if (
      (lines.length === 3 ||
        /^(?:The previous version \(.+\) is still serving|The current version \(.+\) is still running)\.$/u.test(
          lines[1] ?? "",
        )) &&
      [...FAILED_PHASE_DESCRIPTIONS.values(), UNKNOWN_FAILED_PHASE].some(
        (description) =>
          failure.startsWith(`Update failed ${description} (`) &&
          /\([a-z0-9-]+\)\.$/u.test(failure),
      )
    ) {
      return true;
    }
  }
  return (
    [...UPDATE_RUN_HEADLINES.keys()].some(
      (status) => status !== "running" && text === renderUpdateRunSummary({ status, reason: null }),
    ) ||
    [null, ...SKIPPED_UPDATE_RUN_HEADLINES.keys()].some(
      (reason) => text === renderUpdateRunSummary({ status: "skipped", reason }),
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
