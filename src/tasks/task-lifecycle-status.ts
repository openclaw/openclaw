import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { sanitizeUserFacingText } from "../agents/pi-embedded-helpers/errors.js";
import { loadSessionStore, resolveStorePath, type SessionEntry } from "../config/sessions.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { truncateUtf16Safe } from "../utils.js";
import { getTaskById } from "./runtime-internal.js";
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
  | "wait"
  | "session_state"
  | "linked_task_reason";

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

export type BackingSessionState =
  | "running"
  | "done"
  | "failed"
  | "killed"
  | "timeout"
  | "idle"
  | "error"
  | "missing";

export type BackingSessionSnapshot = {
  state: BackingSessionState;
  source: "session_status" | "acp_state" | "missing";
  summary: string;
  recordedAt?: number;
  endedAt?: number;
};

function findSessionEntryByKey(
  store: Record<string, SessionEntry>,
  sessionKey: string,
): SessionEntry | undefined {
  const direct = store[sessionKey];
  if (direct) {
    return direct;
  }
  const normalized = sessionKey.toLowerCase();
  for (const [key, entry] of Object.entries(store)) {
    if (key.toLowerCase() === normalized) {
      return entry;
    }
  }
  return undefined;
}

function summarizeBackingSessionState(state: Exclude<BackingSessionState, "missing">): string {
  switch (state) {
    case "running":
      return "Backing session is running.";
    case "done":
      return "Backing session finished; task has not reconciled yet.";
    case "failed":
      return "Backing session failed; task has not reconciled yet.";
    case "killed":
      return "Backing session was killed; task has not reconciled yet.";
    case "timeout":
      return "Backing session timed out; task has not reconciled yet.";
    case "idle":
      return "Backing session is idle; task is waiting for the next session turn.";
    case "error":
      return "Backing session hit an error; task has not reconciled yet.";
  }
}

function mapPersistedSessionStatus(
  status: SessionEntry["status"],
  recordedAt?: number,
  endedAt?: number,
): BackingSessionSnapshot | undefined {
  if (!status) {
    return undefined;
  }
  return {
    state: status,
    source: "session_status",
    summary: summarizeBackingSessionState(status),
    recordedAt,
    endedAt,
  };
}

function loadPersistedBackingSessionSnapshot(
  sessionKey: string,
): BackingSessionSnapshot | undefined {
  const agentId = parseAgentSessionKey(sessionKey)?.agentId;
  const storePath = resolveStorePath(undefined, { agentId });
  const store = loadSessionStore(storePath);
  const entry = findSessionEntryByKey(store, sessionKey);
  if (!entry) {
    return {
      state: "missing",
      source: "missing",
      summary: "Backing session is missing; task may be orphaned.",
    };
  }
  return mapPersistedSessionStatus(entry.status, entry.updatedAt, entry.endedAt);
}

export function resolveTaskBackingSessionSnapshot(
  task: Pick<TaskRecord, "runtime" | "childSessionKey" | "status"> & {
    runtime?: TaskRecord["runtime"];
  },
): BackingSessionSnapshot | undefined {
  const childSessionKey = normalizeId(task.childSessionKey);
  if (!childSessionKey || task.status !== "running") {
    return undefined;
  }

  if (task.runtime === "acp") {
    const acpEntry = readAcpSessionEntry({ sessionKey: childSessionKey });
    if (!acpEntry || acpEntry.storeReadFailed) {
      return undefined;
    }
    if (!acpEntry.entry) {
      return {
        state: "missing",
        source: "missing",
        summary: "Backing session is missing; task may be orphaned.",
      };
    }
    const acpState = acpEntry.acp?.state;
    if (acpState === "running" || acpState === "idle" || acpState === "error") {
      return {
        state: acpState,
        source: "acp_state",
        summary: summarizeBackingSessionState(acpState),
        recordedAt: acpEntry.acp?.lastActivityAt ?? acpEntry.entry.updatedAt,
      };
    }
    return mapPersistedSessionStatus(
      acpEntry.entry.status,
      acpEntry.entry.updatedAt,
      acpEntry.entry.endedAt,
    );
  }

  try {
    return loadPersistedBackingSessionSnapshot(childSessionKey);
  } catch {
    return undefined;
  }
}

function resolveTaskReasonCode(
  task: Pick<TaskRecord, "status" | "terminalOutcome" | "error" | "progressSummary">,
  backingSession?: BackingSessionSnapshot,
): string {
  if (task.status === "succeeded" && task.terminalOutcome === "blocked") {
    return "blocked";
  }
  if (task.status === "running") {
    if (sanitizeLifecycleText(task.progressSummary)) {
      return task.status;
    }
    if (backingSession?.state === "missing") {
      return "missing_backing_session";
    }
    if (backingSession && backingSession.state !== "running") {
      return "blocked_on_backing_session_state";
    }
    if (backingSession?.state === "running") {
      return "waiting_on_backing_session";
    }
  }
  if (task.status === "lost") {
    const error = task.error?.toLowerCase() ?? "";
    return error.includes("backing session") ? "lost_backing_session" : "lost";
  }
  return task.status;
}

function resolveTaskReasonSummary(
  task: {
    status: TaskRecord["status"];
    terminalOutcome?: TaskRecord["terminalOutcome"];
    progressSummary?: string;
    terminalSummary?: string;
    error?: string;
  },
  backingSession?: BackingSessionSnapshot,
): string {
  const progress = sanitizeLifecycleText(task.progressSummary);
  const terminal = sanitizeLifecycleText(task.terminalSummary, { errorContext: true });
  const error = sanitizeLifecycleText(task.error, { errorContext: true });
  switch (task.status) {
    case "queued":
      return progress || "Queued for execution.";
    case "running":
      if (progress) {
        return progress;
      }
      if (backingSession?.state === "missing") {
        return backingSession.summary;
      }
      if (backingSession && backingSession.state !== "running") {
        return backingSession.summary;
      }
      return backingSession?.summary || "Task is running.";
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
    | "runtime"
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
  > & { runtime?: TaskRecord["runtime"] },
): LifecycleStatusReason {
  const evidence: LifecycleStatusEvidence[] = [];
  const backing: LifecycleBackingLink[] = [];
  const recordedAt = task.endedAt ?? task.lastEventAt;
  const backingSession = resolveTaskBackingSessionSnapshot(task);

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
  pushEvidence(
    evidence,
    makeEvidence({
      kind: "session_state",
      value: backingSession?.summary,
      data: backingSession
        ? {
            state: backingSession.state,
            source: backingSession.source,
          }
        : undefined,
      recordedAt: backingSession?.recordedAt,
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
    code: resolveTaskReasonCode(task, backingSession),
    summary: resolveTaskReasonSummary(task, backingSession),
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

function summarizeLinkedTaskReason(
  prefix: string,
  reason: LifecycleStatusReason | undefined,
): string | undefined {
  const summary = sanitizeLifecycleText(reason?.summary, { errorContext: true });
  return summary ? `${prefix}: ${summary}` : undefined;
}

function resolveLinkedTaskLifecycleReason(
  taskId: string | undefined,
): LifecycleStatusReason | undefined {
  const normalizedTaskId = normalizeId(taskId);
  if (!normalizedTaskId) {
    return undefined;
  }
  try {
    const task = getTaskById(normalizedTaskId);
    return task ? resolveTaskLifecycleStatusReason(task) : undefined;
  } catch {
    return undefined;
  }
}

function resolveFlowReasonSummary(
  flow: Pick<
    TaskFlowRecord,
    "status" | "currentStep" | "blockedSummary" | "blockedTaskId" | "waitJson" | "cancelRequestedAt"
  >,
  linkedTaskReasons?: {
    blockedTaskReason?: LifecycleStatusReason;
    waitTaskReason?: LifecycleStatusReason;
  },
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
      return (
        summarizeLinkedTaskReason("Waiting on task", linkedTaskReasons?.waitTaskReason) ||
        waitSummary ||
        (currentStep ? `Waiting: ${currentStep}` : "Flow is waiting.")
      );
    case "blocked":
      return (
        blockedSummary ||
        summarizeLinkedTaskReason("Blocked on task", linkedTaskReasons?.blockedTaskReason) ||
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
  const blockedTaskId = normalizeId(flow.blockedTaskId);
  const waitTaskId = resolveWaitTaskId(flow.waitJson);
  const blockedTaskReason = resolveLinkedTaskLifecycleReason(blockedTaskId);
  const waitTaskReason = resolveLinkedTaskLifecycleReason(waitTaskId);

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
  pushEvidence(
    evidence,
    (() => {
      if (!blockedTaskReason || !blockedTaskId) {
        return undefined;
      }
      return makeEvidence({
        kind: "linked_task_reason",
        value: blockedTaskReason.summary,
        errorContext: true,
        data: {
          relation: "blocked_task",
          taskId: blockedTaskId,
          code: blockedTaskReason.code,
        },
        recordedAt: flow.updatedAt,
      });
    })(),
  );
  pushEvidence(
    evidence,
    (() => {
      if (!waitTaskReason || !waitTaskId) {
        return undefined;
      }
      return makeEvidence({
        kind: "linked_task_reason",
        value: waitTaskReason.summary,
        errorContext: true,
        data: {
          relation: "wait_task",
          taskId: waitTaskId,
          code: waitTaskReason.code,
        },
        recordedAt: flow.updatedAt,
      });
    })(),
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
    blockedTaskId
      ? { kind: "task" as const, relation: "blocked_task" as const, id: blockedTaskId }
      : undefined,
  );
  pushBacking(
    backing,
    waitTaskId ? { kind: "task", relation: "wait_task", id: waitTaskId } : undefined,
  );

  return buildReason({
    code: resolveFlowReasonCode(flow),
    summary: resolveFlowReasonSummary(flow, {
      blockedTaskReason,
      waitTaskReason,
    }),
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
