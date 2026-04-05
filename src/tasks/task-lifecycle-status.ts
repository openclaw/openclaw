import { sanitizeUserFacingText } from "../agents/pi-embedded-helpers/errors.js";
import { truncateUtf16Safe } from "../utils.js";
import type { JsonValue, TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskRecord } from "./task-registry.types.js";

const DEFAULT_REASON_MAX_CHARS = 120;

export type LifecycleStatusEvidenceKind =
  | "status"
  | "progress_summary"
  | "terminal_summary"
  | "error"
  | "blocked_summary"
  | "current_step"
  | "wait";

export type LifecycleStatusEvidence = {
  kind: LifecycleStatusEvidenceKind;
  summary?: string;
  data?: JsonValue;
  recordedAt?: number;
};

export type LifecycleBackingLinkKind = "task" | "flow" | "session";

export type LifecycleBackingLinkRelation =
  | "owner_session"
  | "child_session"
  | "parent_flow"
  | "parent_task"
  | "blocked_task"
  | "wait_task";

export type LifecycleBackingLink = {
  kind: LifecycleBackingLinkKind;
  relation: LifecycleBackingLinkRelation;
  id: string;
};

export type LifecycleStatusReason = {
  code: string;
  summary: string;
  evidence?: LifecycleStatusEvidence[];
  backing?: LifecycleBackingLink[];
};

function truncateText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${truncateUtf16Safe(trimmed, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function sanitizeLifecycleValue(value: unknown, errorContext: boolean): unknown {
  if (typeof value === "string") {
    const sanitized = sanitizeUserFacingText(value, { errorContext }).replace(/\s+/g, " ").trim();
    return sanitized || undefined;
  }
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => sanitizeLifecycleValue(entry, errorContext))
      .filter((entry) => entry !== undefined);
    return next.length > 0 ? next : undefined;
  }
  if (value && typeof value === "object") {
    const nextEntries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, sanitizeLifecycleValue(entry, errorContext)] as const)
      .filter(([, entry]) => entry !== undefined);
    if (nextEntries.length === 0) {
      return undefined;
    }
    return Object.fromEntries(nextEntries);
  }
  return value;
}

function sanitizeLifecycleText(
  value: unknown,
  opts?: { errorContext?: boolean; maxChars?: number },
): string {
  const sanitizedValue = sanitizeLifecycleValue(value, opts?.errorContext ?? false);
  const raw =
    typeof sanitizedValue === "string"
      ? sanitizedValue
      : sanitizedValue == null
        ? ""
        : (JSON.stringify(sanitizedValue) ?? "");
  const sanitized = raw.replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return "";
  }
  if (typeof opts?.maxChars === "number") {
    return truncateText(sanitized, opts.maxChars);
  }
  return sanitized;
}

function normalizeId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function pushEvidence(
  evidence: LifecycleStatusEvidence[],
  next: LifecycleStatusEvidence | undefined,
): void {
  if (!next) {
    return;
  }
  if (
    evidence.some(
      (entry) =>
        entry.kind === next.kind &&
        entry.summary === next.summary &&
        JSON.stringify(entry.data) === JSON.stringify(next.data) &&
        entry.recordedAt === next.recordedAt,
    )
  ) {
    return;
  }
  evidence.push(next);
}

function pushBacking(
  backing: LifecycleBackingLink[],
  next: LifecycleBackingLink | undefined,
): void {
  if (!next) {
    return;
  }
  if (
    backing.some(
      (entry) =>
        entry.kind === next.kind && entry.relation === next.relation && entry.id === next.id,
    )
  ) {
    return;
  }
  backing.push(next);
}

function makeEvidence(params: {
  kind: LifecycleStatusEvidenceKind;
  value?: unknown;
  errorContext?: boolean;
  data?: JsonValue;
  recordedAt?: number;
}): LifecycleStatusEvidence | undefined {
  const summary = sanitizeLifecycleText(params.value, {
    errorContext: params.errorContext,
  });
  if (!summary && params.data === undefined && params.recordedAt == null) {
    return undefined;
  }
  return {
    kind: params.kind,
    ...(summary ? { summary } : {}),
    ...(params.data !== undefined ? { data: params.data } : {}),
    ...(params.recordedAt != null ? { recordedAt: params.recordedAt } : {}),
  };
}

function buildReason(params: {
  code: string;
  summary: string;
  evidence?: LifecycleStatusEvidence[];
  backing?: LifecycleBackingLink[];
}): LifecycleStatusReason {
  return {
    code: params.code,
    summary: params.summary,
    ...(params.evidence && params.evidence.length > 0 ? { evidence: params.evidence } : {}),
    ...(params.backing && params.backing.length > 0 ? { backing: params.backing } : {}),
  };
}

function summarizeWaitJson(waitJson: JsonValue | undefined): string | undefined {
  if (waitJson === undefined || waitJson === null) {
    return undefined;
  }
  if (typeof waitJson === "string") {
    return sanitizeLifecycleText(waitJson) || undefined;
  }
  if (typeof waitJson !== "object" || Array.isArray(waitJson)) {
    return sanitizeLifecycleText(waitJson) || undefined;
  }
  const kind = typeof waitJson.kind === "string" ? waitJson.kind.trim() : "";
  if (kind === "task") {
    return "Waiting on another task.";
  }
  if (kind === "external_event") {
    const topic = typeof waitJson.topic === "string" ? waitJson.topic.trim() : "";
    return topic ? `Waiting on ${topic}.` : "Waiting on an external event.";
  }
  if (kind) {
    return `Waiting on ${kind.replaceAll("_", " ")}.`;
  }
  return "Waiting for the next lifecycle event.";
}

function resolveWaitTaskId(waitJson: JsonValue | undefined): string | undefined {
  if (!waitJson || typeof waitJson !== "object" || Array.isArray(waitJson)) {
    return undefined;
  }
  if (typeof waitJson.kind !== "string" || waitJson.kind.trim() !== "task") {
    return undefined;
  }
  return typeof waitJson.taskId === "string" ? normalizeId(waitJson.taskId) : undefined;
}

function resolveTaskReasonCode(
  task: Pick<TaskRecord, "status" | "terminalOutcome" | "error">,
): string {
  if (task.status === "succeeded" && task.terminalOutcome === "blocked") {
    return "blocked";
  }
  if (task.status === "lost") {
    const error = task.error?.toLowerCase() ?? "";
    return error.includes("backing session") ? "lost_backing_session" : "lost";
  }
  return task.status;
}

function resolveTaskReasonSummary(task: {
  status: TaskRecord["status"];
  terminalOutcome?: TaskRecord["terminalOutcome"];
  progressSummary?: string;
  terminalSummary?: string;
  error?: string;
}): string {
  const progress = sanitizeLifecycleText(task.progressSummary);
  const terminal = sanitizeLifecycleText(task.terminalSummary, { errorContext: true });
  const error = sanitizeLifecycleText(task.error, { errorContext: true });
  switch (task.status) {
    case "queued":
      return progress || "Queued for execution.";
    case "running":
      return progress || "Task is running.";
    case "succeeded":
      if (task.terminalOutcome === "blocked") {
        return terminal || progress || "Task needs operator follow-up.";
      }
      return terminal || "Task completed successfully.";
    case "failed":
      return error || terminal || "Task failed.";
    case "timed_out":
      return error || terminal || "Task timed out.";
    case "cancelled":
      return error || terminal || "Task was cancelled.";
    case "lost":
      return error || terminal || "Task lost its backing session.";
  }
}

export function resolveTaskLifecycleStatusReason(
  task: Pick<
    TaskRecord,
    | "status"
    | "terminalOutcome"
    | "progressSummary"
    | "terminalSummary"
    | "error"
    | "parentFlowId"
    | "parentTaskId"
    | "childSessionKey"
    | "ownerKey"
    | "lastEventAt"
    | "endedAt"
  >,
): LifecycleStatusReason {
  const evidence: LifecycleStatusEvidence[] = [];
  const backing: LifecycleBackingLink[] = [];
  const recordedAt = task.endedAt ?? task.lastEventAt;

  pushEvidence(
    evidence,
    makeEvidence({ kind: "status", value: task.status.replaceAll("_", " "), recordedAt }),
  );
  pushEvidence(
    evidence,
    makeEvidence({
      kind: "progress_summary",
      value: task.progressSummary,
      recordedAt: task.lastEventAt,
    }),
  );
  pushEvidence(
    evidence,
    makeEvidence({
      kind: "terminal_summary",
      value: task.terminalSummary,
      errorContext: true,
      recordedAt: task.endedAt ?? task.lastEventAt,
    }),
  );
  pushEvidence(
    evidence,
    makeEvidence({
      kind: "error",
      value: task.error,
      errorContext: true,
      recordedAt: task.endedAt ?? task.lastEventAt,
    }),
  );

  pushBacking(
    backing,
    (() => {
      const id = normalizeId(task.parentFlowId);
      return id ? { kind: "flow" as const, relation: "parent_flow" as const, id } : undefined;
    })(),
  );
  pushBacking(
    backing,
    (() => {
      const id = normalizeId(task.parentTaskId);
      return id ? { kind: "task" as const, relation: "parent_task" as const, id } : undefined;
    })(),
  );
  pushBacking(
    backing,
    (() => {
      const id = normalizeId(task.childSessionKey);
      return id ? { kind: "session" as const, relation: "child_session" as const, id } : undefined;
    })(),
  );
  pushBacking(
    backing,
    (() => {
      const id = normalizeId(task.ownerKey);
      return id ? { kind: "session" as const, relation: "owner_session" as const, id } : undefined;
    })(),
  );

  return buildReason({
    code: resolveTaskReasonCode(task),
    summary: resolveTaskReasonSummary(task),
    evidence,
    backing,
  });
}

function resolveFlowReasonCode(flow: Pick<TaskFlowRecord, "status" | "waitJson">): string {
  if (flow.status === "waiting" && resolveWaitTaskId(flow.waitJson)) {
    return "waiting_on_task";
  }
  if (
    flow.status === "waiting" &&
    flow.waitJson &&
    typeof flow.waitJson === "object" &&
    !Array.isArray(flow.waitJson)
  ) {
    const kind = typeof flow.waitJson.kind === "string" ? flow.waitJson.kind.trim() : "";
    if (kind === "external_event") {
      return "waiting_on_external_event";
    }
  }
  return flow.status;
}

function resolveFlowReasonSummary(
  flow: Pick<
    TaskFlowRecord,
    "status" | "currentStep" | "blockedSummary" | "blockedTaskId" | "waitJson" | "cancelRequestedAt"
  >,
): string {
  const currentStep = sanitizeLifecycleText(flow.currentStep);
  const blockedSummary = sanitizeLifecycleText(flow.blockedSummary, { errorContext: true });
  const waitSummary = summarizeWaitJson(flow.waitJson);
  switch (flow.status) {
    case "queued":
      return currentStep ? `Queued: ${currentStep}` : "Flow is queued.";
    case "running":
      return currentStep ? `Running: ${currentStep}` : "Flow is running.";
    case "waiting":
      return waitSummary || (currentStep ? `Waiting: ${currentStep}` : "Flow is waiting.");
    case "blocked":
      return (
        blockedSummary ||
        waitSummary ||
        (flow.blockedTaskId?.trim() ? "Flow is blocked on a child task." : "Flow is blocked.")
      );
    case "succeeded":
      return currentStep ? `Completed: ${currentStep}` : "Flow completed successfully.";
    case "failed":
      return blockedSummary || (currentStep ? `Failed: ${currentStep}` : "Flow failed.");
    case "cancelled":
      return flow.cancelRequestedAt != null ? "Flow was cancelled." : "Flow is cancelled.";
    case "lost":
      return blockedSummary || "Flow was lost.";
  }
}

export function resolveTaskFlowLifecycleStatusReason(params: {
  flow: Pick<
    TaskFlowRecord,
    | "status"
    | "currentStep"
    | "blockedTaskId"
    | "blockedSummary"
    | "waitJson"
    | "ownerKey"
    | "cancelRequestedAt"
    | "updatedAt"
    | "endedAt"
  >;
}): LifecycleStatusReason {
  const { flow } = params;
  const evidence: LifecycleStatusEvidence[] = [];
  const backing: LifecycleBackingLink[] = [];
  const waitTaskId = resolveWaitTaskId(flow.waitJson);

  pushEvidence(
    evidence,
    makeEvidence({
      kind: "status",
      value: flow.status.replaceAll("_", " "),
      recordedAt: flow.endedAt ?? flow.updatedAt,
    }),
  );
  pushEvidence(
    evidence,
    makeEvidence({ kind: "current_step", value: flow.currentStep, recordedAt: flow.updatedAt }),
  );
  pushEvidence(
    evidence,
    makeEvidence({
      kind: "blocked_summary",
      value: flow.blockedSummary,
      errorContext: true,
      recordedAt: flow.endedAt ?? flow.updatedAt,
    }),
  );
  pushEvidence(
    evidence,
    makeEvidence({
      kind: "wait",
      value: summarizeWaitJson(flow.waitJson),
      data: flow.waitJson,
      recordedAt: flow.updatedAt,
    }),
  );

  pushBacking(
    backing,
    (() => {
      const id = normalizeId(flow.ownerKey);
      return id ? { kind: "session" as const, relation: "owner_session" as const, id } : undefined;
    })(),
  );
  pushBacking(
    backing,
    (() => {
      const id = normalizeId(flow.blockedTaskId);
      return id ? { kind: "task" as const, relation: "blocked_task" as const, id } : undefined;
    })(),
  );
  pushBacking(
    backing,
    waitTaskId ? { kind: "task", relation: "wait_task", id: waitTaskId } : undefined,
  );

  return buildReason({
    code: resolveFlowReasonCode(flow),
    summary: resolveFlowReasonSummary(flow),
    evidence,
    backing,
  });
}

export function formatLifecycleStatusReasonSummary(
  reason: LifecycleStatusReason | undefined,
  opts?: { maxChars?: number },
): string | undefined {
  const summary = reason?.summary?.trim();
  if (!summary) {
    return undefined;
  }
  return truncateText(summary, opts?.maxChars ?? DEFAULT_REASON_MAX_CHARS);
}

export function formatLifecycleBackingSummary(
  reason: LifecycleStatusReason | undefined,
  opts?: { maxLinks?: number; maxChars?: number },
): string | undefined {
  const links =
    reason?.backing
      ?.flatMap((entry) => {
        switch (entry.relation) {
          case "parent_flow":
            return ["linked flow"];
          case "parent_task":
            return ["parent task"];
          case "child_session":
            return ["child session"];
          case "blocked_task":
            return ["blocked task"];
          case "wait_task":
            return ["waiting task"];
          case "owner_session":
            return [];
        }
      })
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, opts?.maxLinks ?? 2) ?? [];
  if (links.length === 0) {
    return undefined;
  }
  return truncateText(links.join(" · "), opts?.maxChars ?? DEFAULT_REASON_MAX_CHARS);
}
