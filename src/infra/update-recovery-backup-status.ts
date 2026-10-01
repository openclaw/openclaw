import { formatErrorMessage } from "./errors.js";
import {
  hasUpdateRecoveryForwardResolution,
  readUpdateRecoveryBackups,
} from "./update-recovery-backup-reader.js";
import { getUpdateRunAsync } from "./update-run-reader.js";
import type { UpdateRunRecord } from "./update-run-record.js";

function resolveUpdateRecoveryTerminalOutcome(
  run: UpdateRunRecord | undefined,
  manifestSha256: string,
): "committed" | "restored" | undefined {
  if (run?.status === "succeeded") {
    return "committed";
  }
  // Other rollback steps may restore a later snapshot than this original capture.
  if (
    run?.origin.updateRecoveryCapture?.restored === true &&
    run.origin.updateRecoveryCapture.manifestSha256 === manifestSha256
  ) {
    return "restored";
  }
  return undefined;
}

/** Backup-local pending markers cannot override the update's durable terminal result. */
export async function inspectUpdateRecoveryBackups(params: { installRoot?: string } = {}) {
  const evidence = await readUpdateRecoveryBackups(params.installRoot);
  const snapshots = evidence.filter((entry) => entry.kind === "sealed");
  const forwardResolved = new Set<string>();
  for (const { ref } of snapshots) {
    if (await hasUpdateRecoveryForwardResolution(ref)) {
      forwardResolved.add(ref.manifestSha256);
    }
  }
  const inspected = await Promise.all(
    snapshots.map(async ({ ref, manifest, outcome }) => {
      if (forwardResolved.has(ref.manifestSha256)) {
        return {
          ref,
          runId: manifest.runId,
          captureStatus: outcome.status,
          status: "forward-resolved" as const,
          terminalOutcome: undefined,
          nextAction: "openclaw update status --json",
          message: `Update recovery set ${ref.manifestPath}: current state repaired forward; failed history and all generations retained.`,
        };
      }
      let terminalOutcome: "committed" | "restored" | undefined;
      let ambiguity: string | undefined;
      try {
        const run = await getUpdateRunAsync(manifest.runId);
        if (
          !run &&
          manifest.schemaVersion === 2 &&
          manifest.generation?.kind === "baseline" &&
          /^doctor-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            manifest.runId,
          )
        ) {
          return {
            ref,
            runId: manifest.runId,
            captureStatus: outcome.status,
            status: "manual" as const,
            terminalOutcome: undefined,
            nextAction: "openclaw update status --json",
            message: `Standalone Doctor capture ${ref.manifestPath}: pre-repair state retained for manual inspection. No repair outcome is recorded.`,
          };
        }
        terminalOutcome = resolveUpdateRecoveryTerminalOutcome(run, ref.manifestSha256);
        if (outcome.status === "committed" || outcome.status === "restored") {
          if (terminalOutcome && terminalOutcome !== outcome.status) {
            terminalOutcome = undefined;
            ambiguity = "capture and update terminal outcomes disagree";
          } else {
            terminalOutcome = outcome.status;
          }
        }
        if (run?.origin.updateRecoveryCapture?.doctorCompleted && !terminalOutcome) {
          ambiguity = "Doctor succeeded but its older updater has no complete runtime validation";
        }
        if (!terminalOutcome && !ambiguity && run?.status !== "failed") {
          ambiguity = run ? `update run is ${run.status}` : "no matching update run exists";
        }
      } catch (error) {
        ambiguity = `update outcome is unreadable: ${formatErrorMessage(error)}`;
      }
      if (!terminalOutcome && !ambiguity && snapshots.length - forwardResolved.size > 1) {
        ambiguity =
          "other recovery sets exist; restoring this set could discard newer database writes";
      }
      const status: "stale" | "ambiguous" | "unresolved" = terminalOutcome
        ? "stale"
        : ambiguity
          ? "ambiguous"
          : "unresolved";
      const nextAction =
        status === "unresolved"
          ? `Preserve current state and inspect ${ref.manifestPath} before manual recovery. See https://docs.openclaw.ai/cli/update/repair-and-recovery#original-state-captures`
          : "openclaw update status --json";
      const reason = terminalOutcome
        ? `stale: its update already ${terminalOutcome === "committed" ? "succeeded" : "restored state"}`
        : (ambiguity ?? "unresolved after a failed update");
      return {
        ref,
        runId: manifest.runId,
        captureStatus: outcome.status,
        status,
        terminalOutcome,
        nextAction,
        message: `Update recovery set ${ref.manifestPath}: ${reason}. ${status === "unresolved" ? `Retained original state requires manual inspection. ${nextAction}` : `Automatic restoration is refused; inspect with \`${nextAction}\`.`}${status === "ambiguous" ? " Resolve the recorded outcome before attempting recovery." : ""}`,
      };
    }),
  );
  return [
    ...inspected,
    ...evidence
      .filter((entry) => entry.kind === "incomplete")
      .map(({ directory }) => ({
        directory,
        status: "incomplete" as const,
        nextAction: "openclaw update status --json",
        message: `Update capture at ${directory} is incomplete: no sealed manifest is available. Retained files are unverified evidence for manual inspection.`,
      })),
  ];
}
