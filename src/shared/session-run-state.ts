import type { SessionRunStatus } from "../../packages/gateway-protocol/src/schema/sessions-row.js";

/** Live execution facts, not a job's schedule or the conversation's last outcome. */
export type SessionAutomationRun = {
  runId: string;
  jobId: string;
  name: string;
  startedAt: number;
  status: "queued" | "running";
};

type SessionRunState = {
  hasActiveRun?: boolean;
  status?: SessionRunStatus;
  automationRuns?: readonly SessionAutomationRun[];
};

/** Automation execution does not replace the conversation's last lifecycle outcome. */
export function projectSessionActiveStatus(
  active: { active: boolean; status?: "queued"; preserveStatus?: true } | null | undefined,
  status: SessionRunStatus | undefined,
): SessionRunStatus | undefined {
  return active?.active && !active.preserveStatus ? (active.status ?? "running") : status;
}

export function isSessionRunStateActive(state: SessionRunState): boolean {
  if (state.hasActiveRun === true && state.automationRuns?.length) {
    return true;
  }
  if (state.status && state.status !== "queued" && state.status !== "running") {
    return false;
  }
  if (typeof state.hasActiveRun === "boolean") {
    return state.hasActiveRun;
  }
  return state.status === "queued" || state.status === "running";
}
