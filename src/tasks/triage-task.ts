// Native task observations are projections, never leases or cancellation authority.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { observeTriageBacking, type TriageBackingObservation } from "../infra/triage-backing.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

const scopeSchema = z.strictObject({
  taskId: z.string().min(1),
  runtime: z.literal("cli"),
  taskKind: z.literal("triage_repair"),
  sourceId: z.string().min(1),
  runId: z.string().min(1),
  ownerKey: z.string(),
  scopeKind: z.enum(["system", "session"]),
  requesterSessionKey: z.string(),
  childSessionKey: z.string().optional(),
});
const detailSchema = z.strictObject({
  kind: z.literal("triage_repair"),
  version: z.literal(1),
  taskScope: scopeSchema,
  backing: z.unknown(),
  originalUpdateRunId: z.string().max(128).optional(),
  executionStartedAt: z.number().int().nonnegative(),
});
const scopeKeys = [
  "taskId",
  "runtime",
  "taskKind",
  "sourceId",
  "runId",
  "ownerKey",
  "scopeKind",
  "requesterSessionKey",
  "childSessionKey",
] as const;

export function readTriageTaskDetail(task: TaskRecord) {
  if (task.runtime !== "cli" || task.taskKind !== "triage_repair") {
    return undefined;
  }
  const result = detailSchema.safeParse(task.detail);
  if (!result.success) {
    return undefined;
  }
  const detail = result.data;
  if (scopeKeys.some((key) => detail.taskScope[key] !== task[key])) {
    return undefined;
  }
  const generation = asOptionalRecord(asOptionalRecord(detail.backing)?.generation);
  if (
    generation?.owner !== detail.taskScope.runId ||
    detail.taskScope.sourceId !== detail.taskScope.runId ||
    task.startedAt !== detail.executionStartedAt
  ) {
    return undefined;
  }
  return detail;
}

/** Retention above is deliberately separate from this fresh observation of execution. */
export function triageTaskExecutionPhase(task: TaskRecord): "running" | "closing" | undefined {
  if (task.status !== "running" || task.endedAt) {
    return undefined;
  }
  const detail = readTriageTaskDetail(task);
  let rawIdentityMatched = false;
  try {
    rawIdentityMatched =
      Boolean(detail) && getTaskRegistryStore().matchesTaskIdentity?.(task) === true;
  } catch {
    // Optional custom-store probes cannot break status views or invent liveness.
  }
  const observation: TriageBackingObservation =
    detail && rawIdentityMatched
      ? observeTriageBacking(detail.backing)
      : { kind: "unavailable", reason: "invalid-reference" };
  if (
    observation.kind === "matched" &&
    observation.helper === "live" &&
    observation.executor === "live" &&
    observation.lifetime === "matched" &&
    (observation.phase === "running" || observation.phase === "closing")
  ) {
    return observation.phase;
  }
  return undefined;
}

export function triageTaskProgressSummary(task: TaskRecord): string | undefined {
  if (
    task.runtime !== "cli" ||
    task.taskKind !== "triage_repair" ||
    (task.status !== "queued" && task.status !== "running")
  ) {
    return undefined;
  }
  const phase = triageTaskExecutionPhase(task);
  if (phase === "running") {
    return "Repair executing; effects not yet verified. Cancellation unavailable.";
  }
  if (phase === "closing") {
    return "Repair settling; completion unconfirmed. Cancellation unavailable.";
  }
  return "Repair execution unconfirmed; do not retry automatically. Cancellation unavailable.";
}
