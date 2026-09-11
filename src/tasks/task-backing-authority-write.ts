import { inspectDefaultSubagentTaskBacking } from "./detached-task-runtime.js";
import { isProvisionalSubagentKillTask } from "./task-cancellation-state.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import type { JsonValue, TaskRecord, TaskRuntime } from "./task-registry.types.js";

type CanonicalTaskBacking = {
  runtime: TaskRuntime;
  ownerKey: string;
  childSessionKey: string;
  runId: string;
  generation: number | undefined;
  detail: JsonValue;
};

export type PreparedCanonicalTaskReplacement = {
  kind: "valid";
  current: TaskRecord;
  next: TaskRecord;
};

export type PreparedCanonicalTaskActivation =
  | { kind: "custom" }
  | { kind: "invalid"; reason: string }
  | PreparedCanonicalTaskReplacement;

/** Prepares the task half of an atomic replacement without publishing it early. */
export function prepareCanonicalTaskActivation(
  params: CanonicalTaskBacking & {
    startedAt: number;
    preserveProvisionalCancellation?: boolean;
  },
): PreparedCanonicalTaskActivation {
  const backing = inspectDefaultSubagentTaskBacking({
    runId: params.runId,
    ownerKey: params.ownerKey,
    sessionKey: params.childSessionKey,
    generation: params.generation,
    policy: "failure-finalization",
  });
  if (backing.kind !== "valid") {
    return backing;
  }
  if (backing.task.runtime !== params.runtime) {
    return { kind: "invalid", reason: "uses a different runtime" };
  }
  const current = backing.task;
  const next = cloneTaskRecord(current);
  next.detail = structuredClone(params.detail);
  if (
    current.status === "succeeded" ||
    (current.status === "cancelled" &&
      (!isProvisionalSubagentKillTask(current) || params.preserveProvisionalCancellation === true))
  ) {
    return { kind: "valid", current, next };
  }
  next.status = "running";
  next.startedAt = current.startedAt ?? params.startedAt;
  next.lastEventAt = params.startedAt;
  // Silent collectors never enter the delivery queue when their owner generation changes.
  next.deliveryStatus = current.deliveryStatus === "not_applicable" ? "not_applicable" : "pending";
  delete next.endedAt;
  delete next.cleanupAfter;
  delete next.error;
  delete next.progressSummary;
  delete next.terminalSummary;
  delete next.terminalOutcome;
  return { kind: "valid", current, next };
}
