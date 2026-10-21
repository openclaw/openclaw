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
