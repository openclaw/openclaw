import { collectUpdateCaptureInventory } from "../commands/update-capture-cleanup.js";
import { resolveStateDir } from "../config/paths.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { formatErrorMessage } from "./errors.js";
import {
  hasUpdateRecoveryForwardResolution,
  readUpdateRecoveryBackups,
} from "./update-recovery-backup-reader.js";
import { isNeverActivatedFailedUpdate } from "./update-run-activation.js";
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

function unreadableCapture(directory: string, error: string) {
  return {
    directory,
    status: "unreadable" as const,
    nextAction:
      "Preserve this capture and current state; inspect with openclaw update status --json before manual recovery.",
    message: `Update capture at ${directory} is unreadable: ${error}. Retained files are unverified evidence for manual inspection.`,
  };
}

/** Backup-local pending markers cannot override the update's durable terminal result. */
export async function inspectUpdateRecoveryBackups(readRun = getUpdateRunAsync) {
  // Inventory and restoration diagnostics share one ledger snapshot. Status skips
  // payload byte measurement; cleanup alone needs those totals for confirmation.
  const { captures, evidence } = await withOpenClawStateDatabaseReadSnapshot(
    async () => {
      const inventory = collectUpdateCaptureInventory({
        stateDir: resolveStateDir(process.env),
        env: process.env,
        measureBytes: false,
      });
      const invalidRoot = inventory.artifacts.find(
        (item) => item.reason === "capture-directory-alias",
      );
      if (invalidRoot) {
        throw new Error(`Capture root is aliased or not a directory: ${invalidRoot.path}`);
      }
      const byDirectory = new Map(
        inventory.artifacts.filter((item) => item.captureSource).map((item) => [item.path, item]),
      );
      return {
        captures: byDirectory,
        evidence: await readUpdateRecoveryBackups(readRun, [...byDirectory.keys()]),
      };
    },
    { lazy: true },
  );
  const classified = await Promise.all(
    evidence.map(async (entry) => {
      if (entry.kind === "unreadable") {
        return unreadableCapture(entry.directory, entry.error);
      }
      const directory = entry.kind === "sealed" ? entry.ref.directory : entry.directory;
      const cleanup = captures.get(directory)!;
      if (
        cleanup.outcome === "candidate" ||
        cleanup.reason === "superseded-unsealed-capture" ||
        (cleanup.reason === "orphan-update-capture" &&
          entry.kind === "sealed" &&
          !entry.run &&
          entry.outcome.status === "pending")
      ) {
        const nextAction =
          cleanup.outcome === "candidate"
            ? "openclaw update cleanup --dry-run"
            : `openclaw update cleanup --dry-run --include-unmanifested "${directory}"`;
        return Object.assign(
          {
            directory,
            status: "warning" as const,
            nextAction,
            message: `Update capture at ${directory}: ${cleanup.reason}. ${cleanup.detail ?? ""} Preview retirement with \`${nextAction}\`; remove --dry-run to retire it after confirmation.`,
          },
          entry.kind === "sealed"
            ? { runId: entry.manifest.runId, manifestPath: entry.ref.manifestPath }
            : {},
        );
      }
      if (entry.kind === "incomplete") {
        return {
          directory: entry.directory,
          status: "incomplete" as const,
          nextAction: "openclaw update cleanup --dry-run",
          message: `Update capture at ${entry.directory} is incomplete: no sealed manifest is available. Retained files are unverified evidence for manual inspection; cleanup explains their protection (${cleanup.reason}).`,
        };
      }
      const { ref, manifest, outcome, run } = entry;
      let forwardResolved: boolean;
      try {
        forwardResolved = await hasUpdateRecoveryForwardResolution(ref, run);
      } catch (error) {
        return unreadableCapture(ref.directory, formatErrorMessage(error));
      }
      if (forwardResolved) {
        return {
          ref,
          runId: manifest.runId,
          captureStatus: outcome.status,
          status: "forward-resolved" as const,
          terminalOutcome: undefined,
          nextAction: "openclaw update cleanup --dry-run",
          message: `Update recovery set ${ref.manifestPath}: current state repaired forward; failed history and all generations retained.`,
        };
      }
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
          nextAction: "openclaw update cleanup --dry-run",
          message: `Standalone Doctor capture ${ref.manifestPath}: pre-repair state retained for manual inspection. No repair outcome is recorded. Cleanup retention: ${cleanup.reason}.`,
        };
      }
      let terminalOutcome = resolveUpdateRecoveryTerminalOutcome(run, ref.manifestSha256);
      let ambiguity: string | undefined;
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
      // A failure that never activated left the captured state live; nothing needs recovery.
      const unchanged =
        !terminalOutcome && !ambiguity && run !== undefined && isNeverActivatedFailedUpdate(run);
      return { ref, manifest, outcome, terminalOutcome, unchanged, ambiguity };
    }),
  );
  // Completed captures cannot compete with a failed capture for recovery. Count
  // only after all outcomes are known; unreadable and manual evidence stays conservative.
  const competing = classified.filter((entry) => {
    if (entry.status === "warning") {
      const cleanup = captures.get(entry.directory)!;
      // Released originals and unsealed evidence cannot compete for restoration;
      // orphan warnings with an unknown outcome still require conservative inspection.
      return cleanup.outcome !== "candidate" && cleanup.reason !== "superseded-unsealed-capture";
    }
    return entry.status === undefined
      ? !entry.terminalOutcome && !entry.unchanged
      : entry.status !== "forward-resolved" && entry.status !== "incomplete";
  });
  const inspected = classified.map((entry) => {
    if (entry.status !== undefined) {
      return entry;
    }
    const { ref, manifest, outcome, terminalOutcome, unchanged } = entry;
    let { ambiguity } = entry;
    if (!unchanged && !terminalOutcome && !ambiguity && competing.length > 1) {
      ambiguity =
        "other recovery sets exist; restoring this set could discard newer database writes";
    }
    const status: "stale" | "ambiguous" | "unresolved" =
      terminalOutcome || unchanged ? "stale" : ambiguity ? "ambiguous" : "unresolved";
    const nextAction =
      status === "unresolved"
        ? `Preserve current state and inspect ${ref.manifestPath} before manual recovery. See https://docs.openclaw.ai/cli/update/repair-and-recovery#original-state-captures`
        : unchanged
          ? "openclaw update cleanup"
          : "openclaw update cleanup --dry-run";
    const reason = terminalOutcome
      ? `stale: its update already ${terminalOutcome === "committed" ? "succeeded" : "restored state"}`
      : unchanged
        ? "stale: its update failed before changing the installation or state"
        : (ambiguity ?? "unresolved after a failed update");
    return {
      ref,
      runId: manifest.runId,
      captureStatus: outcome.status,
      status,
      terminalOutcome,
      nextAction,
      message: `Update recovery set ${ref.manifestPath}: ${reason}. ${status === "unresolved" ? `Retained original state requires manual inspection. ${nextAction}` : unchanged ? `Nothing needs recovery; retire it with \`${nextAction}\`.` : `Automatic restoration is refused; inspect with \`${nextAction}\`.`}${status === "ambiguous" ? " Resolve the recorded outcome before attempting recovery." : ""}`,
    };
  });
  return inspected;
}
