import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isWellFormedApprovalId } from "../../../packages/gateway-protocol/src/schema/approval-id.js";
import { isRecord } from "../../utils.js";

/** A recorded watcher observation, never a live resource or execution permission. */
type ToolStreamLifecycle = {
  jobId: string;
  name: string;
  enabled: boolean;
  status: "starting" | "running" | "restarting" | "stopped" | "disabled" | "error" | "unknown";
};

/** Only canonical job facts may supply the immediate tool outcome. */
function readToolStreamLifecycle(value: unknown): ToolStreamLifecycle | undefined {
  const result = asOptionalRecord(value);
  if (
    !result ||
    result.saved === false ||
    result.status !== undefined ||
    result.error !== undefined
  ) {
    return undefined;
  }
  const job = asOptionalRecord(result.job) ?? result;
  const state = asOptionalRecord(job.state);
  const id = job.id;
  if (
    typeof id !== "string" ||
    id.length > 1_024 ||
    id.trim() !== id ||
    !isWellFormedApprovalId(id) ||
    asOptionalRecord(job.schedule)?.kind !== "stream" ||
    typeof job.enabled !== "boolean" ||
    !state
  ) {
    return undefined;
  }
  const status = state.streamStatus;
  if (
    status !== "starting" &&
    status !== "running" &&
    status !== "restarting" &&
    status !== "stopped" &&
    status !== "disabled" &&
    status !== "error" &&
    status !== undefined
  ) {
    return undefined;
  }
  return {
    jobId: id,
    name: typeof job.name === "string" && job.name.trim() ? truncateUtf16Safe(job.name, 512) : id,
    enabled: job.enabled,
    status: status ?? "unknown",
  };
}

export function formatCronTerminalPresentation(
  params: unknown,
  result: unknown,
): { text: string } | undefined {
  if (!isRecord(params) || !isRecord(result) || !isRecord(result.details)) {
    return undefined;
  }
  if (params.action === "get" || params.action === "add" || params.action === "update") {
    const observation = readToolStreamLifecycle(result.details);
    if (observation && result.isError !== true) {
      const stopped = observation.status === "stopped" || observation.status === "disabled";
      const status = stopped
        ? "Source termination confirmed."
        : !observation.enabled
          ? "Paused. Source termination is not confirmed."
          : observation.status === "unknown"
            ? "Saved. Source state is not confirmed."
            : observation.status === "error"
              ? "Source needs attention. Termination is not confirmed."
              : `Source ${observation.status}.`;
      return {
        text: `Recorded watcher observation: ${observation.name}\n${status}\nAutomation ID: ${observation.jobId}`,
      };
    }
  }
  switch (params.action) {
    case "status": {
      const enabled = result.details.enabled === true ? "yes" : "no";
      return { text: `Automations scheduler status.\nEnabled: ${enabled}` };
    }
    case "list": {
      const total =
        typeof result.details.total === "number" &&
        Number.isFinite(result.details.total) &&
        result.details.total >= 0
          ? Math.floor(result.details.total)
          : undefined;
      const count =
        total ?? (Array.isArray(result.details.jobs) ? result.details.jobs.length : undefined);
      return count === undefined
        ? { text: "Automations listed." }
        : { text: `Automations listed.\nCount: ${count}` };
    }
    case "get":
      return { text: "Automation loaded." };
    case "runs": {
      const entries = Array.isArray(result.details.entries)
        ? result.details.entries.length
        : undefined;
      return entries === undefined
        ? { text: "Automation run history loaded." }
        : { text: `Automation run history loaded.\nCount: ${entries}` };
    }
    default:
      return undefined;
  }
}

export function buildCronSelfDescription(params: {
  activeRun: boolean;
  nextCheckEnabled: boolean;
}): string {
  const inspection =
    "Inspect or remove only the current automation. Actions: status; list [includeDisabled] (enabled only by default); get/remove jobId; runs jobId [limit,offset,runId] reads this job's recorded outcomes and delivery receipts (status, channel/target, message IDs when recorded), including deliveries through another account. This grants no channel-history access. Use get with the current job ID to inspect its saved state. To stop a finished job, remove it; creating/updating/running jobs and waking sessions are unavailable. Return the task result; the scheduler owns delivery.";
  if (!params.activeRun) {
    return inspection;
  }
  return (
    inspection +
    " scratch_get reads this job's checklist and revision; scratch_set replaces or clears content using expectedRevision from the read (reread after a revision conflict). record_result accepts one outcome (no_change, progress, done, blocked, needs_attention). Omit summary for no_change; other outcomes require a trimmed 1–2000-character summary. Unchanged state and repeated known blockers stay quiet with no_change and NO_REPLY; explicit recurring digests/reports still deliver as requested. Use existing deterministic condition triggers or scripts to skip inference for machine-checkable no-change. no_change or NO_REPLY keeps the response silent." +
    (params.nextCheckEnabled
      ? ' next_check in:"15m" proposes the next delay for this paced job or one-shot session continuation, including a scheduler-admitted restart continuation. A successful one-shot proposal rearms this same job from run end (minimum 2s); without one it completes normally.'
      : "")
  );
}
