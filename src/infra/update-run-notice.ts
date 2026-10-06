import type { UpdateRunRecord } from "./update-run-record.js";

export type UpdateRunNoticeKind = "ack" | "parking" | "activating" | "verifying" | "finished";

/** Chat shows the outcome; the update views keep diagnostics and recovery instructions. */
export function renderUpdateRunSummary(
  run: Pick<UpdateRunRecord, "status" | "reason">,
  options: { manualCommand?: string } = {},
): string {
  let headline: string;
  switch (run.status) {
    case "succeeded":
      headline = "✅ OpenClaw updated.";
      break;
    case "failed":
      headline = "⚠️ OpenClaw couldn't finish updating.";
      break;
    case "rolled-back":
      headline = "↩️ The update couldn't finish. OpenClaw returned to the previous version.";
      break;
    case "running":
      headline = "⬆️ OpenClaw is updating.";
      break;
    case "skipped":
      headline =
        run.reason === "already-current"
          ? "✅ OpenClaw is already up to date."
          : run.reason === "still-starting"
            ? "⏳ OpenClaw is installed and still starting."
            : run.reason === "gateway-readiness-unverified"
              ? "⚠️ OpenClaw is installed, but we couldn't confirm it's ready."
              : run.reason === "managed-service-handoff-already-running"
                ? "⬆️ OpenClaw is already updating."
                : "ℹ️ OpenClaw wasn't updated.";
      break;
  }
  const nextStep = options.manualCommand
    ? `Open Settings → Updates in the Control UI for details. To continue, run \`${options.manualCommand}\` in your terminal.`
    : "For details, open Settings → Updates in the Control UI or run `openclaw update status` in your terminal.";
  return `${headline}\n${nextStep}`;
}

/** Only the current milestone may produce a conversation notice. */
export function renderUpdateRunNotice(
  run: Pick<UpdateRunRecord, "status" | "reason" | "phase">,
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
    return "⏳ Restarting OpenClaw…";
  }
  return "🔁 Checking that OpenClaw is ready…";
}
