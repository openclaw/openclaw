import { hasExecutionSettlement } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  AgentActivityItemSchema,
  type AgentActivityItem,
} from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  isCompleteAgentPreamble,
  projectAgentActivityItem,
} from "../agents/agent-activity-presentation.js";
import { readCompletedFileMutationDelta } from "../agents/file-mutation-args.js";
import { resolveFileMutationToolName } from "../agents/tool-mutation-names.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { readTaskBackingInstance } from "./task-backing-records.js";
import { cloneTaskRecordForObserver } from "./task-registry-records.js";
import {
  clearTaskActivity,
  emitTaskRegistryObserverEvent,
  taskActivityByTaskId,
  tasks,
} from "./task-registry-state.js";
import type { TaskActivityOverlayState } from "./task-registry.process-state.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";

const MAX_ACTIVITY_CHARS = 200;
const ACTIVITY_LINE_PREFIX = new RegExp(`^(?:\\s*\\S){1,${MAX_ACTIVITY_CHARS + 1}}`);
const STREAM_TEXT_BUFFER_CHARS = 4_000;
const ACTIVITY_FLUSH_MS = 1_000;
const MAX_PENDING_DIFFS = 64;
const MAX_CURRENT_TOOLS = 64;
const MAX_PREPARED_ITEMS = 64;
const liveActivitySchema = Type.Object(
  {
    ...AgentActivityItemSchema.properties,
    itemId: Type.Optional(AgentActivityItemSchema.properties.itemId),
  },
  { additionalProperties: true },
);

type TaskActivitySnapshot = {
  lastActivity?: string;
  diffStat?: { files: number; added: number; removed: number };
  executionRunId?: string;
  executionState?: TaskActivityOverlayState["executionState"];
  executionWait?: TaskActivityOverlayState["executionWait"];
  lastActivityAt?: number;
  currentTool?: { name: string; startedAt: number };
};

function activityFor(task: TaskRecord): TaskActivityOverlayState {
  const runId = task.runId ?? "";
  const preparedGeneration = readTaskBackingInstance(task.detail)?.generation;
  const existing = taskActivityByTaskId.get(task.taskId);
  if (existing?.runId === runId) {
    if (existing.preparedGeneration !== preparedGeneration) {
      existing.preparedItems.clear();
      existing.preparedGeneration = preparedGeneration;
    }
    return existing;
  }
  if (existing?.flushTimer) {
    clearTimeout(existing.flushTimer);
  }
  existing?.preparedItems.clear();
  const created: TaskActivityOverlayState = {
    runId,
    currentTools: new Map(),
    preparedItems: new Map(),
    preparedGeneration,
    pendingApprovalIds: new Set(),
    assistantText: "",
    thinkingText: "",
    hasAssistantActivity: false,
    files: new Set(),
    added: 0,
    removed: 0,
    pendingDiffByToolCallId: new Map(),
    dirty: false,
  };
  taskActivityByTaskId.set(task.taskId, created);
  return created;
}

function lastLineSnippet(text: string): string | undefined {
  const line = text
    .trimEnd()
    .split(/\r\n|\r|\n/)
    .at(-1);
  // Normalize only the prefix; the extra nonspace unit preserves a surrogate pair
  // crossing the truncation boundary without copying the whole growing line.
  const prefix = line?.match(ACTIVITY_LINE_PREFIX)?.[0];
  return prefix
    ? truncateUtf16Safe(prefix.replace(/\s+/g, " ").trim(), MAX_ACTIVITY_CHARS)
    : undefined;
}

function scheduleFlush(taskId: string, activity: TaskActivityOverlayState): void {
  if (activity.flushTimer) {
    return;
  }
  const elapsed = activity.lastFlushedAt === undefined ? 0 : Date.now() - activity.lastFlushedAt;
  const delay = Math.max(0, ACTIVITY_FLUSH_MS - elapsed);
  activity.flushTimer = setTimeout(() => {
    activity.flushTimer = undefined;
    flushTaskActivity(taskId);
  }, delay);
  activity.flushTimer.unref?.();
}

function markChanged(taskId: string, activity: TaskActivityOverlayState): void {
  activity.dirty = true;
  scheduleFlush(taskId, activity);
}

/** Coalesces producer-owned activity without persisting or duplicating its execution state. */
export function invalidateTaskActivity(taskId: string, at: number): void {
  const task = tasks.get(taskId);
  if (!task || isTerminalTaskStatus(task.status)) {
    return;
  }
  const activity = activityFor(task);
  activity.lastActivityAt = Math.max(activity.lastActivityAt ?? at, at);
  markChanged(taskId, activity);
}

function readExecutionWait(value: unknown): TaskActivityOverlayState["executionWait"] {
  const wait = asOptionalObjectRecord(value);
  if (wait?.kind === "approval" || wait?.kind === "user_input" || wait?.kind === "agent_messages") {
    return { kind: wait.kind };
  }
  if (wait?.kind !== "children" || !Array.isArray(wait.dependencies)) {
    return undefined;
  }
  const dependencies = wait.dependencies.slice(0, 32).flatMap((candidate) => {
    const dependency = asOptionalObjectRecord(candidate);
    const runId = normalizeOptionalString(dependency?.runId);
    const sessionKey = normalizeOptionalString(dependency?.sessionKey);
    return runId ? [{ runId, ...(sessionKey ? { sessionKey } : {}) }] : [];
  });
  if (!dependencies.length) {
    return undefined;
  }
  return {
    kind: "children",
    dependencies,
    pendingCount:
      typeof wait.pendingCount === "number" &&
      Number.isSafeInteger(wait.pendingCount) &&
      wait.pendingCount >= dependencies.length
        ? wait.pendingCount
        : dependencies.length,
  };
}

export function readPreparedTaskActivityItem(
  event: AgentEventPayload,
): AgentActivityItem | undefined {
  if (event.stream !== "item" || !Value.Check(liveActivitySchema, event.data)) {
    return undefined;
  }
  const item = projectAgentActivityItem(event.data);
  const itemId =
    item.itemId ??
    (item.kind === "preamble" && item.progressText?.trim() && isCompleteAgentPreamble(item)
      ? `preamble:${event.seq}`
      : undefined);
  if (!itemId) {
    return undefined;
  }
  if (item.hideFromChannelProgress || item.suppressChannelProgress) {
    return {
      itemId,
      kind: item.kind,
      phase: item.phase,
      title: "",
      hideFromChannelProgress: item.hideFromChannelProgress,
      suppressChannelProgress: true,
    };
  }
  // Live events may carry private telemetry. Retain only the prepared public contract.
  return {
    itemId,
    kind: item.kind,
    phase: item.phase,
    status: item.status,
    title: item.title,
    progressText: item.progressText,
    toolCallId: item.toolCallId,
    name: item.name,
    meta: item.meta,
    commandBearing: item.commandBearing,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    error: item.error,
    summary: item.summary,
    approvalId: item.approvalId,
    approvalSlug: item.approvalSlug,
    hideFromChannelProgress: item.hideFromChannelProgress,
    suppressChannelProgress: item.suppressChannelProgress,
  };
}

/** Folds transient text and file activity into the in-memory task overlay. */
export function recordTaskActivityEvent(
  task: TaskRecord,
  event: AgentEventPayload,
): AgentActivityItem | undefined {
  const activity = activityFor(task);
  if (activity.executionRunId !== event.runId) {
    // Task identity survives a resumed execution; its in-flight calls do not.
    activity.executionRunId = event.runId;
    activity.currentTools.clear();
    activity.preparedItems.clear();
    activity.pendingApprovalIds.clear();
    activity.approvalObservationOverflow = undefined;
    activity.pendingDiffByToolCallId.clear();
    activity.executionState = undefined;
    activity.executionWait = undefined;
    activity.executionId = undefined;
    activity.executionSourceId = undefined;
  }
  if (event.stream === "item") {
    const prepared = readPreparedTaskActivityItem(event);
    if (!prepared) {
      return undefined;
    }
    activity.preparedItems.delete(prepared.itemId);
    if (prepared.suppressChannelProgress) {
      return prepared;
    }
    activity.preparedItems.set(prepared.itemId, prepared);
    if (activity.preparedItems.size > MAX_PREPARED_ITEMS) {
      const oldest = activity.preparedItems.keys().next().value;
      if (oldest !== undefined) {
        activity.preparedItems.delete(oldest);
      }
    }
    return prepared;
  }
  if (event.stream === "execution") {
    const approval = asOptionalObjectRecord(event.data.approval);
    const approvalId = normalizeOptionalString(approval?.id);
    if (approvalId && (approval?.state === "pending" || approval?.state === "resolved")) {
      if (approval.state === "pending") {
        if (activity.pendingApprovalIds.size < MAX_CURRENT_TOOLS) {
          activity.pendingApprovalIds.add(approvalId);
        } else if (!activity.pendingApprovalIds.has(approvalId)) {
          activity.approvalObservationOverflow = true;
        }
      } else if (!activity.pendingApprovalIds.delete(approvalId)) {
        return undefined;
      }
      activity.lastActivityAt = event.ts;
      markChanged(task.taskId, activity);
      return undefined;
    }
    const sourceId = normalizeOptionalString(event.data.sourceId);
    if (event.data.invalidate === true && (!sourceId || activity.executionSourceId !== sourceId)) {
      return undefined;
    }
    const state = event.data.state;
    if (state !== "running" && state !== "waiting" && state !== "unknown") {
      return undefined;
    }
    const executionId = normalizeOptionalString(event.data.executionId);
    if (
      state === "unknown" ||
      (sourceId && activity.executionSourceId !== sourceId) ||
      (executionId && activity.executionId !== executionId)
    ) {
      activity.currentTools.clear();
      activity.pendingDiffByToolCallId.clear();
    }
    if (sourceId) {
      activity.executionSourceId = sourceId;
    }
    if (executionId) {
      if (activity.executionId && activity.executionId !== executionId) {
        activity.pendingApprovalIds.clear();
        activity.approvalObservationOverflow = undefined;
      }
      activity.executionId = executionId;
    }
    activity.executionState = state;
    activity.executionWait = state === "waiting" ? readExecutionWait(event.data.wait) : undefined;
    activity.lastActivityAt = event.ts;
    markChanged(task.taskId, activity);
    return undefined;
  }
  if (event.stream === "lifecycle") {
    const phase = event.data.phase;
    if (phase === "start" || phase === "end" || phase === "error") {
      // Execution can settle before the task owner records its final outcome.
      activity.executionState =
        phase === "start" ? "running" : hasExecutionSettlement(event.data) ? "finished" : "unknown";
      activity.executionWait = undefined;
      activity.pendingApprovalIds.clear();
      activity.approvalObservationOverflow = undefined;
      activity.currentTools.clear();
      activity.pendingDiffByToolCallId.clear();
      activity.lastActivityAt = event.ts;
      markChanged(task.taskId, activity);
    }
    return undefined;
  }
  if (
    (event.stream === "tool" && event.data.phase === "start") ||
    event.stream === "assistant" ||
    event.stream === "thinking"
  ) {
    // An overlapping tool or text delta cannot resolve an owner-reported wait.
    if (activity.executionState !== "waiting") {
      activity.executionState = "running";
      activity.executionWait = undefined;
    }
    activity.lastActivityAt = event.ts;
  }
  if (event.stream === "tool" && (event.data.phase === "result" || event.data.phase === "end")) {
    activity.lastActivityAt = event.ts;
  }
  const textStream = event.stream;
  if (textStream === "assistant" || textStream === "thinking") {
    if (textStream === "thinking" && activity.hasAssistantActivity) {
      return undefined;
    }
    const key = textStream === "assistant" ? "assistantText" : "thinkingText";
    let cumulative: string;
    if (typeof event.data.text === "string") {
      cumulative = event.data.text;
    } else if (typeof event.data.delta === "string") {
      cumulative = activity[key] + event.data.delta;
    } else {
      return undefined;
    }
    // Retain only a suffix for delta-only producers; full snapshots remain authoritative.
    activity[key] = sliceUtf16Safe(cumulative, -STREAM_TEXT_BUFFER_CHARS);
    const snippet = lastLineSnippet(cumulative);
    if (!snippet) {
      return undefined;
    }
    if (textStream === "assistant") {
      activity.hasAssistantActivity = true;
      activity.thinkingText = "";
    }
    if (activity.lastActivity !== snippet) {
      activity.lastActivity = snippet;
      markChanged(task.taskId, activity);
    }
    return undefined;
  }

  if (event.stream !== "tool") {
    return undefined;
  }
  const toolName = typeof event.data.name === "string" ? event.data.name : "";
  const toolCallId = normalizeOptionalString(event.data.toolCallId);
  if (toolCallId && event.data.phase === "start" && toolName.trim()) {
    if (activity.currentTools.size < MAX_CURRENT_TOOLS || activity.currentTools.has(toolCallId)) {
      activity.currentTools.set(toolCallId, { name: toolName.trim(), startedAt: event.ts });
      markChanged(task.taskId, activity);
    }
  } else if (toolCallId && (event.data.phase === "result" || event.data.phase === "end")) {
    if (activity.currentTools.delete(toolCallId)) {
      markChanged(task.taskId, activity);
    }
  }
  const kind = resolveFileMutationToolName(toolName);
  if (!kind) {
    return undefined;
  }
  if (event.data.phase === "start") {
    const args = asOptionalObjectRecord(event.data.args);
    const delta = args ? readCompletedFileMutationDelta(kind, args) : undefined;
    if (!toolCallId || !delta) {
      return undefined;
    }
    if (
      !activity.pendingDiffByToolCallId.has(toolCallId) &&
      activity.pendingDiffByToolCallId.size >= MAX_PENDING_DIFFS
    ) {
      return undefined;
    }
    activity.pendingDiffByToolCallId.set(toolCallId, delta);
    return undefined;
  }
  if (event.data.phase !== "result") {
    return undefined;
  }
  const delta = toolCallId ? activity.pendingDiffByToolCallId.get(toolCallId) : undefined;
  if (toolCallId) {
    activity.pendingDiffByToolCallId.delete(toolCallId);
  }
  if (event.data.isError === true || !delta) {
    return undefined;
  }
  let changed = delta.added > 0 || delta.removed > 0;
  for (const file of delta.files) {
    const size = activity.files.size;
    activity.files.add(file);
    changed ||= activity.files.size !== size;
  }
  if (changed) {
    activity.added += delta.added;
    activity.removed += delta.removed;
    markChanged(task.taskId, activity);
  }
  return undefined;
}

export function getTaskPreparedActivity(
  taskId: string,
): ReadonlyMap<string, AgentActivityItem> | undefined {
  const activity = taskActivityByTaskId.get(taskId);
  const task = tasks.get(taskId);
  return activity &&
    task &&
    activity.runId === (task.runId ?? "") &&
    activity.preparedGeneration === readTaskBackingInstance(task.detail)?.generation
    ? activity.preparedItems
    : undefined;
}

export function getTaskActivitySnapshot(taskId: string): TaskActivitySnapshot | undefined {
  const activity = taskActivityByTaskId.get(taskId);
  const currentTool = activity ? [...activity.currentTools.values()].at(-1) : undefined;
  const executionState = activity?.approvalObservationOverflow
    ? "unknown"
    : activity?.pendingApprovalIds.size
      ? "waiting"
      : activity?.executionState;
  const executionWait =
    activity?.pendingApprovalIds.size || activity?.approvalObservationOverflow
      ? { kind: "approval" as const }
      : activity?.executionWait;
  return activity
    ? {
        ...(activity.executionRunId ? { executionRunId: activity.executionRunId } : {}),
        ...(executionState !== undefined ? { executionState } : {}),
        ...(executionWait ? { executionWait: { ...executionWait } } : {}),
        ...(activity.lastActivityAt !== undefined
          ? { lastActivityAt: activity.lastActivityAt }
          : {}),
        ...(currentTool ? { currentTool: { ...currentTool } } : {}),
        ...(activity.lastActivity ? { lastActivity: activity.lastActivity } : {}),
        ...(activity.files.size > 0
          ? {
              diffStat: {
                files: activity.files.size,
                added: activity.added,
                removed: activity.removed,
              },
            }
          : {}),
      }
    : undefined;
}

export function flushTaskActivity(taskId: string): void {
  const activity = taskActivityByTaskId.get(taskId);
  if (!activity?.dirty) {
    return;
  }
  if (activity.flushTimer) {
    clearTimeout(activity.flushTimer);
    activity.flushTimer = undefined;
  }
  const task = tasks.get(taskId);
  if (!task || isTerminalTaskStatus(task.status)) {
    clearTaskActivity(taskId);
    return;
  }
  activity.dirty = false;
  activity.lastFlushedAt = Date.now();
  emitTaskRegistryObserverEvent(() => ({
    kind: "upserted",
    task: cloneTaskRecordForObserver(task),
  }));
}
