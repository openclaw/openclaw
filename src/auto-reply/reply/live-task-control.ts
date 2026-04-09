import { abortEmbeddedPiRun, resolveActiveEmbeddedRunSessionId } from "../../agents/pi-embedded.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { getQueueSize } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { listTasksForFlowId } from "../../tasks/runtime-internal.js";
import {
  getTaskFlowByIdForOwner,
  listTaskFlowsForOwner,
  resolveTaskFlowForLookupTokenForOwner,
} from "../../tasks/task-flow-owner-access.js";
import {
  acquireTaskFlowBrowserLease,
  beginTaskFlowControllerAction,
  clearTaskFlowBrowserLease,
  createManagedTaskFlow,
  getTaskFlowBrowserLease,
  getTaskFlowControllerAction,
  getTaskFlowById,
  releaseTaskFlowBrowserLease,
  updateTaskFlowControllerAction,
  updateFlowRecordByIdExpectedRevision,
} from "../../tasks/task-flow-registry.js";
import type {
  JsonValue,
  TaskFlowControllerActionRecord,
  TaskFlowControllerActionKind,
  TaskFlowRecord,
} from "../../tasks/task-flow-registry.types.js";
import { sanitizeTaskStatusText } from "../../tasks/task-status.js";
import { listFollowupQueueItems, removeFollowupQueueItems, type FollowupRun } from "./queue.js";
import { replyRunRegistry } from "./reply-run-registry.js";

const LIVE_TASK_CONTROLLER_ID = "auto-reply/live-task-control";
const LIVE_TASK_HANDLE_MAX_CHARS = 8;
const ACTIVE_FLOW_STATUSES = new Set(["queued", "running", "waiting", "blocked"]);
const TERMINAL_FLOW_STATUSES = new Set(["succeeded", "failed", "cancelled", "lost"]);

type LiveTaskWaitKind = "capacity" | "browser_lease";

type ControllerState = {
  foreground?: boolean;
  browserLease?: boolean;
  leaseToken?: string;
};

type RequestState = {
  prompt?: string;
  summaryLine?: string;
  waitKind?: LiveTaskWaitKind;
};

type RuntimeState = {
  inlineActive?: boolean;
  backgroundActive?: boolean;
};

type LiveTaskFlowState = {
  controller: ControllerState;
  request?: RequestState;
  runtime?: RuntimeState;
};

type FlowWaitJson = {
  kind: LiveTaskWaitKind;
  heldByFlowId?: string;
  heldByHandle?: string;
  queuePosition?: number;
};

export type LiveTaskExplicitControl = {
  kind: "explicit";
  action: "continue" | "cancel" | "retry";
  token: string;
  confirmed: boolean;
};

export type LiveTaskControllerIntent =
  | LiveTaskExplicitControl
  | { kind: "queue-summary" }
  | { kind: "blocking-question" }
  | { kind: "bulk-cancel-queued" }
  | { kind: "foreground-steer" }
  | { kind: "ambiguous-control" }
  | { kind: "create" };

export type LiveTaskBoard = {
  all: TaskFlowRecord[];
  foreground?: TaskFlowRecord;
  browserHolder?: TaskFlowRecord;
  blocked: TaskFlowRecord[];
  waiting: TaskFlowRecord[];
  recent: TaskFlowRecord[];
  controllerHealth: string;
};

function sanitizeFlowText(value: unknown, maxChars?: number): string {
  return sanitizeTaskStatusText(value, maxChars == null ? undefined : { maxChars });
}

function isManagedLiveTaskFlow(flow: TaskFlowRecord): boolean {
  return flow.syncMode === "managed" && flow.controllerId === LIVE_TASK_CONTROLLER_ID;
}

function isActiveFlow(flow: TaskFlowRecord): boolean {
  return ACTIVE_FLOW_STATUSES.has(flow.status);
}

function isTerminalFlow(flow: TaskFlowRecord): boolean {
  return TERMINAL_FLOW_STATUSES.has(flow.status);
}

function normalizeControllerStateJson(stateJson: JsonValue | undefined): LiveTaskFlowState {
  if (!stateJson || typeof stateJson !== "object" || Array.isArray(stateJson)) {
    return { controller: {} };
  }
  const root = stateJson as Record<string, unknown>;
  const controllerRoot =
    root.controller && typeof root.controller === "object" && !Array.isArray(root.controller)
      ? (root.controller as Record<string, unknown>)
      : {};
  const requestRoot =
    root.request && typeof root.request === "object" && !Array.isArray(root.request)
      ? (root.request as Record<string, unknown>)
      : undefined;
  const runtimeRoot =
    root.runtime && typeof root.runtime === "object" && !Array.isArray(root.runtime)
      ? (root.runtime as Record<string, unknown>)
      : undefined;
  return {
    controller: {
      foreground: controllerRoot.foreground === true,
      browserLease: controllerRoot.browserLease === true,
      leaseToken:
        typeof controllerRoot.leaseToken === "string" && controllerRoot.leaseToken.trim()
          ? controllerRoot.leaseToken
          : undefined,
    },
    ...(requestRoot
      ? {
          request: {
            prompt:
              typeof requestRoot.prompt === "string" && requestRoot.prompt.trim()
                ? requestRoot.prompt
                : undefined,
            summaryLine:
              typeof requestRoot.summaryLine === "string" && requestRoot.summaryLine.trim()
                ? requestRoot.summaryLine
                : undefined,
            waitKind:
              requestRoot.waitKind === "browser_lease" || requestRoot.waitKind === "capacity"
                ? requestRoot.waitKind
                : undefined,
          },
        }
      : {}),
    ...(runtimeRoot
      ? {
          runtime: {
            inlineActive: runtimeRoot.inlineActive === true,
            backgroundActive: runtimeRoot.backgroundActive === true,
          },
        }
      : {}),
  };
}

function buildStateJson(params: {
  flow?: TaskFlowRecord;
  controller?: Partial<ControllerState>;
  request?: Partial<RequestState>;
  runtime?: Partial<RuntimeState>;
}): JsonValue {
  const current = params.flow
    ? normalizeControllerStateJson(params.flow.stateJson)
    : { controller: {} };
  const controller: ControllerState = {
    foreground: params.controller?.foreground ?? current.controller.foreground ?? false,
    browserLease: params.controller?.browserLease ?? current.controller.browserLease ?? false,
    leaseToken: params.controller?.leaseToken ?? current.controller.leaseToken,
  };
  const requestCurrent = current.request ?? {};
  const request: RequestState = {
    prompt: params.request?.prompt ?? requestCurrent.prompt,
    summaryLine: params.request?.summaryLine ?? requestCurrent.summaryLine,
    waitKind: params.request?.waitKind ?? requestCurrent.waitKind,
  };
  const requestJson = {
    ...(request.prompt ? { prompt: request.prompt } : {}),
    ...(request.summaryLine ? { summaryLine: request.summaryLine } : {}),
    ...(request.waitKind ? { waitKind: request.waitKind } : {}),
  };
  const runtimeCurrent = current.runtime ?? {};
  const runtime: RuntimeState = {
    inlineActive: params.runtime?.inlineActive ?? runtimeCurrent.inlineActive ?? false,
    backgroundActive: params.runtime?.backgroundActive ?? runtimeCurrent.backgroundActive ?? false,
  };
  const runtimeJson = {
    ...(runtime.inlineActive ? { inlineActive: true } : {}),
    ...(runtime.backgroundActive ? { backgroundActive: true } : {}),
  };
  return {
    controller: {
      foreground: controller.foreground === true,
      browserLease: controller.browserLease === true,
      ...(controller.leaseToken ? { leaseToken: controller.leaseToken } : {}),
    },
    ...(Object.keys(requestJson).length > 0 ? { request: requestJson } : {}),
    ...(Object.keys(runtimeJson).length > 0 ? { runtime: runtimeJson } : {}),
  };
}

function updateManagedFlow(
  flowId: string,
  mutator: (flow: TaskFlowRecord) => Record<string, unknown>,
): TaskFlowRecord | undefined {
  let current = getTaskFlowById(flowId);
  if (!current || !isManagedLiveTaskFlow(current)) {
    return current;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: current.flowId,
      expectedRevision: current.revision,
      patch: mutator(current),
    });
    if (result.applied) {
      return result.flow;
    }
    if (result.reason !== "revision_conflict" || !result.current) {
      return result.current ?? undefined;
    }
    current = result.current;
  }
  return current;
}

function clearManagedFlowMarkers(params: {
  ownerKey: string;
  keepFlowId?: string;
  clearForeground?: boolean;
  clearBrowserLease?: boolean;
  clearInlineRuntime?: boolean;
}): void {
  for (const flow of listTaskFlowsForOwner({ callerOwnerKey: params.ownerKey })) {
    if (!isManagedLiveTaskFlow(flow) || flow.flowId === params.keepFlowId) {
      continue;
    }
    const state = normalizeControllerStateJson(flow.stateJson);
    const nextForeground = params.clearForeground ? false : state.controller.foreground;
    const nextBrowserLease = params.clearBrowserLease ? false : state.controller.browserLease;
    const nextInlineRuntime = params.clearInlineRuntime ? false : state.runtime?.inlineActive;
    const nextBackgroundRuntime = params.clearInlineRuntime
      ? false
      : state.runtime?.backgroundActive;
    if (
      nextForeground === state.controller.foreground &&
      nextBrowserLease === state.controller.browserLease &&
      nextInlineRuntime === state.runtime?.inlineActive &&
      nextBackgroundRuntime === state.runtime?.backgroundActive
    ) {
      continue;
    }
    updateManagedFlow(flow.flowId, (current) => ({
      stateJson: buildStateJson({
        flow: current,
        controller: {
          foreground: nextForeground,
          browserLease: nextBrowserLease,
          leaseToken: nextBrowserLease ? state.controller.leaseToken : undefined,
        },
        runtime: {
          inlineActive: nextInlineRuntime,
          backgroundActive: nextBackgroundRuntime,
        },
      }),
    }));
  }
}

function summarizeGoal(run: FollowupRun): string {
  return sanitizeFlowText(run.summaryLine, 96) || sanitizeFlowText(run.prompt, 96) || "Live task";
}

export function formatLiveTaskHandle(flow: Pick<TaskFlowRecord, "flowId">): string {
  return sanitizeFlowText(flow.flowId, LIVE_TASK_HANDLE_MAX_CHARS) || flow.flowId.slice(0, 8);
}

function applyControllerMetadata(
  run: FollowupRun,
  params: {
    flowId: string;
    waitKind: LiveTaskWaitKind;
    skipQueuedLifecycle?: boolean;
    browserLease?: boolean;
  },
): FollowupRun {
  run.controllerFlowId = params.flowId;
  run.controllerAckText = undefined;
  run.controllerBypassQueueLifecycle = params.skipQueuedLifecycle === true;
  run.controllerBrowserLease = params.browserLease === true;
  run.controller = {
    flowId: params.flowId,
    waitKind: params.waitKind,
    skipQueuedLifecycle: params.skipQueuedLifecycle === true,
  };
  return run;
}

function buildWaitJson(params: {
  kind: LiveTaskWaitKind;
  heldByFlowId?: string;
  queuePosition?: number;
}): FlowWaitJson {
  return {
    kind: params.kind,
    ...(params.heldByFlowId ? { heldByFlowId: params.heldByFlowId } : {}),
    ...(params.heldByFlowId
      ? { heldByHandle: formatLiveTaskHandle({ flowId: params.heldByFlowId }) }
      : {}),
    ...(typeof params.queuePosition === "number" ? { queuePosition: params.queuePosition } : {}),
  };
}

function waitKindFromText(text: string): LiveTaskWaitKind {
  return /\b(browser|warm|tab|page|site|click|reply)\b/i.test(text) ? "browser_lease" : "capacity";
}

export function isAuthorizedLiveTaskOperator(run: FollowupRun): boolean {
  if (run.run.senderIsOwner === true) {
    return true;
  }
  const senderId = run.run.senderId?.trim();
  if (!senderId) {
    return false;
  }
  return (run.run.ownerNumbers ?? []).some((entry) => entry.trim() === senderId);
}

function buildLiveTaskControllerActionKey(params: {
  ownerKey: string;
  updateId: string;
  normalizedAction: string;
}): string {
  return JSON.stringify([params.ownerKey.trim(), params.updateId.trim(), params.normalizedAction]);
}

function buildLiveTaskControllerHealth(): string {
  const depth = getQueueSize(CommandLane.Controller);
  if (depth > 1) {
    return `busy (${depth} controller actions queued)`;
  }
  if (depth === 1) {
    return "busy";
  }
  return "healthy";
}

function buildLiveTaskControllerReplayText(params: {
  sessionKey: string;
  record: TaskFlowControllerActionRecord;
}): string {
  const existingText = params.record.responseText?.trim();
  if (existingText) {
    return existingText;
  }
  const flowId = params.record.flowId?.trim();
  if (flowId) {
    const flow = getTaskFlowByIdForOwner({
      flowId,
      callerOwnerKey: params.sessionKey,
    });
    if (flow && isManagedLiveTaskFlow(flow)) {
      return buildLiveTaskHandleStatusReply(reconcileFlow(flow)).text;
    }
  }
  return params.record.kind === "create"
    ? "Still processing your last control message.\nNext: /tasks"
    : "That control action is already in progress.\nNext: /tasks";
}

function getBrowserLeaseHolderForOwner(ownerKey: string): TaskFlowRecord | undefined {
  const lease = getTaskFlowBrowserLease();
  if (!lease || lease.ownerKey !== ownerKey) {
    return undefined;
  }
  const flow = getTaskFlowByIdForOwner({
    flowId: lease.flowId,
    callerOwnerKey: ownerKey,
  });
  return flow && isManagedLiveTaskFlow(flow) ? flow : undefined;
}

function getForegroundFlowForOwner(ownerKey: string): TaskFlowRecord | undefined {
  return listTaskFlowsForOwner({ callerOwnerKey: ownerKey })
    .filter((flow) => isManagedLiveTaskFlow(flow) && isActiveFlow(flow))
    .find((flow) => normalizeControllerStateJson(flow.stateJson).controller.foreground);
}

function queuePositionForFlow(ownerKey: string, flowId: string): number | undefined {
  const items = listFollowupQueueItems(ownerKey);
  const index = items.findIndex((item) => item.controller?.flowId === flowId);
  return index >= 0 ? index + 1 : undefined;
}

function hasQueuedRunForFlow(ownerKey: string, flowId: string): boolean {
  return listFollowupQueueItems(ownerKey).some((item) => item.controller?.flowId === flowId);
}

function hasActiveLinkedTasks(flowId: string): boolean {
  return listTasksForFlowId(flowId).some(
    (task) => task.status === "queued" || task.status === "running",
  );
}

function extractQueuePosition(flow: TaskFlowRecord): number | undefined {
  if (!flow.waitJson || typeof flow.waitJson !== "object" || Array.isArray(flow.waitJson)) {
    return undefined;
  }
  const queuePosition = (flow.waitJson as Record<string, unknown>).queuePosition;
  return typeof queuePosition === "number" && Number.isFinite(queuePosition)
    ? queuePosition
    : undefined;
}

function markFlowLost(flow: TaskFlowRecord, now = Date.now()): TaskFlowRecord {
  const state = normalizeControllerStateJson(flow.stateJson);
  if (state.controller.leaseToken) {
    releaseTaskFlowBrowserLease({
      flowId: flow.flowId,
      token: state.controller.leaseToken,
    });
  } else if (getTaskFlowBrowserLease()?.flowId === flow.flowId) {
    clearTaskFlowBrowserLease();
  }
  const updated =
    updateManagedFlow(flow.flowId, (current) => ({
      status: "lost",
      blockedSummary: current.blockedSummary ?? "Runtime disappeared before the flow finished.",
      waitJson: null,
      endedAt: current.endedAt ?? now,
      stateJson: buildStateJson({
        flow: current,
        controller: {
          foreground: false,
          browserLease: false,
          leaseToken: undefined,
        },
        runtime: {
          inlineActive: false,
          backgroundActive: false,
        },
      }),
    })) ?? flow;
  return {
    ...updated,
    status: "lost",
    blockedSummary: updated.blockedSummary ?? "Runtime disappeared before the flow finished.",
    waitJson: null,
    updatedAt: updated.updatedAt ?? now,
    endedAt: updated.endedAt ?? now,
  };
}

function reconcileFlow(flow: TaskFlowRecord, now = Date.now()): TaskFlowRecord {
  if (!isManagedLiveTaskFlow(flow) || isTerminalFlow(flow)) {
    return flow;
  }
  if (flow.status === "blocked") {
    return flow;
  }
  const state = normalizeControllerStateJson(flow.stateJson);
  const activeReplyRun = replyRunRegistry.isActive(flow.ownerKey);
  const hasInlineRuntime = state.runtime?.inlineActive === true && activeReplyRun;
  const hasBackgroundRuntime = state.runtime?.backgroundActive === true && activeReplyRun;
  const hasLegacyInlineRuntime =
    flow.status === "running" &&
    activeReplyRun &&
    (state.controller.foreground || state.controller.browserLease);
  const hasLinkedTasks = hasActiveLinkedTasks(flow.flowId);
  const queued = hasQueuedRunForFlow(flow.ownerKey, flow.flowId);
  const lease = getTaskFlowBrowserLease();
  const leaseHeldByFlow =
    lease?.flowId === flow.flowId && lease.ownerKey === flow.ownerKey ? lease : undefined;
  if (
    !hasInlineRuntime &&
    !hasBackgroundRuntime &&
    !hasLegacyInlineRuntime &&
    !hasLinkedTasks &&
    !queued
  ) {
    if (leaseHeldByFlow || state.controller.browserLease || state.controller.foreground) {
      return markFlowLost(flow, now);
    }
    return {
      ...flow,
      status: "lost",
      blockedSummary: flow.blockedSummary ?? "Runtime disappeared before the flow finished.",
      waitJson: null,
      updatedAt: now,
      endedAt: flow.endedAt ?? now,
    };
  }
  if (
    flow.status === "waiting" &&
    flow.waitJson &&
    typeof flow.waitJson === "object" &&
    !Array.isArray(flow.waitJson)
  ) {
    const wait = flow.waitJson as Record<string, unknown>;
    const position = queuePositionForFlow(flow.ownerKey, flow.flowId);
    const heldByFlow =
      wait.kind === "browser_lease"
        ? getBrowserLeaseHolderForOwner(flow.ownerKey)
        : getForegroundFlowForOwner(flow.ownerKey);
    return {
      ...flow,
      waitJson: {
        ...wait,
        ...(heldByFlow ? { heldByFlowId: heldByFlow.flowId } : {}),
        ...(heldByFlow ? { heldByHandle: formatLiveTaskHandle(heldByFlow) } : {}),
        ...(typeof position === "number" ? { queuePosition: position } : {}),
      },
    };
  }
  return flow;
}

function formatWaitSummary(flow: TaskFlowRecord): string | undefined {
  if (!flow.waitJson || typeof flow.waitJson !== "object" || Array.isArray(flow.waitJson)) {
    return undefined;
  }
  const wait = flow.waitJson as Record<string, unknown>;
  const heldBy = typeof wait.heldByHandle === "string" ? wait.heldByHandle : undefined;
  const queuePosition =
    typeof wait.queuePosition === "number" && Number.isFinite(wait.queuePosition)
      ? wait.queuePosition
      : undefined;
  if (wait.kind === "browser_lease") {
    const reason = heldBy
      ? `Browser lease held by flow ${heldBy}.`
      : "Waiting for the active browser lease to clear.";
    return queuePosition ? `${reason} Queue position ${queuePosition}.` : reason;
  }
  if (wait.kind === "capacity") {
    const reason = heldBy
      ? `Queued behind foreground flow ${heldBy}.`
      : "Queued behind foreground capacity.";
    return queuePosition ? `${reason} Queue position ${queuePosition}.` : reason;
  }
  return undefined;
}

export function formatLiveTaskState(flow: TaskFlowRecord): string {
  if (flow.status === "blocked") {
    return sanitizeFlowText(flow.blockedSummary, 180) || "Blocked waiting for input.";
  }
  if (flow.status === "waiting") {
    return formatWaitSummary(flow) ?? "Waiting for the foreground flow to clear.";
  }
  if (flow.status === "running") {
    return sanitizeFlowText(flow.currentStep, 180) || "Working now.";
  }
  if (flow.status === "queued") {
    return sanitizeFlowText(flow.currentStep, 180) || "Queued to start.";
  }
  if (flow.status === "lost") {
    return "Runtime disappeared before the flow finished.";
  }
  if (flow.status === "failed") {
    return sanitizeFlowText(flow.blockedSummary, 180) || "Flow failed.";
  }
  if (flow.status === "cancelled") {
    return "Flow was cancelled.";
  }
  return "Completed.";
}

export function formatLiveTaskNextPhrases(flow: TaskFlowRecord): string[] {
  const handle = formatLiveTaskHandle(flow);
  const phrases = [`/tasks ${handle}`];
  if (flow.status === "waiting" || flow.status === "blocked") {
    phrases.unshift(`continue ${handle}`, `cancel ${handle}`);
    return phrases;
  }
  if (flow.status === "running" || flow.status === "queued") {
    phrases.unshift(`cancel ${handle}`);
    return phrases;
  }
  if (flow.status === "failed" || flow.status === "cancelled" || flow.status === "lost") {
    phrases.unshift(`retry ${handle}`);
    return phrases;
  }
  return phrases;
}

export function resolveLiveTaskBoard(sessionKey: string): LiveTaskBoard {
  const flows = listTaskFlowsForOwner({ callerOwnerKey: sessionKey })
    .filter(isManagedLiveTaskFlow)
    .map((flow) => reconcileFlow(flow))
    .toSorted((left, right) => right.createdAt - left.createdAt);
  const foreground = flows.find(
    (flow) => normalizeControllerStateJson(flow.stateJson).controller.foreground,
  );
  const browserHolder = getBrowserLeaseHolderForOwner(sessionKey) ?? foreground;
  const waiting = flows
    .filter((flow) => flow.status === "waiting")
    .toSorted((left, right) => {
      const leftPosition = extractQueuePosition(left);
      const rightPosition = extractQueuePosition(right);
      if (leftPosition == null && rightPosition == null) {
        return left.createdAt - right.createdAt;
      }
      if (leftPosition == null) {
        return 1;
      }
      if (rightPosition == null) {
        return -1;
      }
      return leftPosition === rightPosition
        ? left.createdAt - right.createdAt
        : leftPosition - rightPosition;
    });
  return {
    all: flows,
    foreground,
    browserHolder,
    blocked: flows.filter((flow) => flow.status === "blocked"),
    waiting,
    recent: flows.filter((flow) => isTerminalFlow(flow)).slice(0, 5),
    controllerHealth: buildLiveTaskControllerHealth(),
  };
}

function formatFlowHeadline(flow: TaskFlowRecord): string {
  return `${formatLiveTaskHandle(flow)} · ${sanitizeFlowText(flow.goal, 96) || "Live task"}`;
}

export function buildLiveTaskBoardText(params: {
  sessionKey: string;
  lookup?: string;
}): string | undefined {
  if (params.lookup) {
    const flow = resolveLiveTaskFlow(params.sessionKey, params.lookup);
    if (!flow) {
      return `Unknown flow: ${params.lookup}`;
    }
    const reconciled = reconcileFlow(flow);
    const tasks = listTasksForFlowId(reconciled.flowId);
    const lines = [
      `📋 Flow ${formatLiveTaskHandle(reconciled)}`,
      `Goal: ${sanitizeFlowText(reconciled.goal, 180) || "Live task"}`,
      `Status: ${reconciled.status.replaceAll("_", " ")}`,
      `State: ${formatLiveTaskState(reconciled)}`,
      `Updated: ${formatTimeAgo(Date.now() - reconciled.updatedAt)}`,
      `Next: ${formatLiveTaskNextPhrases(reconciled).join(" · ")}`,
    ];
    if (tasks.length > 0) {
      lines.push("", `Attempts: ${tasks.length}`);
    }
    return lines.join("\n");
  }

  const board = resolveLiveTaskBoard(params.sessionKey);
  if (board.all.length === 0) {
    return undefined;
  }
  const lines = ["📋 Tasks", `Controller: ${board.controllerHealth}`];
  if (board.foreground) {
    lines.push("", `Foreground: ${formatFlowHeadline(board.foreground)}`);
    lines.push(`State: ${formatLiveTaskState(board.foreground)}`);
    lines.push(`Next: ${formatLiveTaskNextPhrases(board.foreground).join(" · ")}`);
  }
  if (board.browserHolder) {
    lines.push("", `Browser holder: ${formatFlowHeadline(board.browserHolder)}`);
  }
  if (board.blocked.length > 0) {
    lines.push("", "Blocked:");
    for (const [index, flow] of board.blocked.entries()) {
      lines.push(`${index + 1}. ${formatFlowHeadline(flow)}`);
      lines.push(`   ${formatLiveTaskState(flow)}`);
      lines.push(`   Next: ${formatLiveTaskNextPhrases(flow).join(" · ")}`);
    }
  }
  if (board.waiting.length > 0) {
    lines.push("", "Waiting:");
    for (const [index, flow] of board.waiting.entries()) {
      lines.push(`${index + 1}. ${formatFlowHeadline(flow)}`);
      lines.push(`   ${formatLiveTaskState(flow)}`);
      lines.push(`   Next: ${formatLiveTaskNextPhrases(flow).join(" · ")}`);
    }
  }
  if (board.recent.length > 0) {
    lines.push("", "Recent:");
    for (const [index, flow] of board.recent.entries()) {
      lines.push(`${index + 1}. ${formatFlowHeadline(flow)}`);
      lines.push(
        `   ${flow.status.replaceAll("_", " ")} · ${formatTimeAgo(Date.now() - (flow.endedAt ?? flow.updatedAt))}`,
      );
      lines.push(`   Next: ${formatLiveTaskNextPhrases(flow).join(" · ")}`);
    }
  }
  lines.push(
    "",
    "Legend: handles are short flow ids. States: running, waiting, blocked, lost.",
    'Control: continue <handle> · cancel <handle> · retry <handle> · say "show queues" · say "cancel all queues"',
  );
  return lines.join("\n");
}

export function buildLiveTaskStatusLine(sessionKey: string): string | undefined {
  const board = resolveLiveTaskBoard(sessionKey);
  if (board.all.length === 0) {
    return undefined;
  }
  const statusPrefix = `📌 Tasks: controller ${board.controllerHealth}`;
  if (board.foreground) {
    const browserHolder =
      board.browserHolder && board.browserHolder.flowId !== board.foreground.flowId
        ? ` · browser ${formatLiveTaskHandle(board.browserHolder)}`
        : board.browserHolder
          ? ` · browser ${formatLiveTaskHandle(board.browserHolder)}`
          : "";
    return `${statusPrefix} · foreground ${formatFlowHeadline(board.foreground)}${browserHolder} · ${formatLiveTaskState(board.foreground)}`;
  }
  if (board.blocked.length > 0) {
    const blocked = board.blocked[0];
    return `${statusPrefix} · blocked ${formatFlowHeadline(blocked)} · ${formatLiveTaskState(blocked)}`;
  }
  if (board.waiting.length > 0) {
    const waiting = board.waiting[0];
    return `${statusPrefix} · waiting ${formatFlowHeadline(waiting)} · ${formatLiveTaskState(waiting)}`;
  }
  const recent = board.recent[0];
  return recent
    ? `${statusPrefix} · ${recent.status.replaceAll("_", " ")} ${formatFlowHeadline(recent)}`
    : undefined;
}

export function isLiveTaskDirectMessage(run: FollowupRun): boolean {
  const provider =
    run.originatingChannel?.trim().toLowerCase() || run.run.messageProvider?.trim().toLowerCase();
  if (provider !== "telegram") {
    return false;
  }
  const chatType = run.originatingChatType?.trim().toLowerCase();
  return (
    chatType !== "group" &&
    chatType !== "supergroup" &&
    chatType !== "channel" &&
    Boolean(run.run.sessionKey?.trim())
  );
}

export function createQueuedLiveTaskFlow(params: {
  queueKey: string;
  followupRun: FollowupRun;
}): TaskFlowRecord {
  const foreground = getForegroundFlowForOwner(params.queueKey);
  const browserHolder = getBrowserLeaseHolderForOwner(params.queueKey);
  const waitKind =
    browserHolder ||
    (foreground && normalizeControllerStateJson(foreground.stateJson).controller.browserLease)
      ? "browser_lease"
      : waitKindFromText(params.followupRun.prompt);
  const existingFlowId = params.followupRun.controller?.flowId?.trim();
  const existing =
    existingFlowId &&
    getTaskFlowByIdForOwner({ flowId: existingFlowId, callerOwnerKey: params.queueKey });
  const flow =
    existing && isManagedLiveTaskFlow(existing)
      ? updateManagedFlow(existing.flowId, (current) => ({
          status: "waiting",
          goal: summarizeGoal(params.followupRun),
          currentStep: "Waiting for the foreground flow to clear.",
          blockedTaskId: null,
          blockedSummary: null,
          endedAt: null,
          waitJson: buildWaitJson({
            kind: waitKind,
            heldByFlowId: browserHolder?.flowId ?? foreground?.flowId,
            queuePosition: getFollowupQueueDepthSafe(params.queueKey) + 1,
          }),
          stateJson: buildStateJson({
            flow: current,
            controller: {
              foreground: false,
              browserLease: false,
              leaseToken: undefined,
            },
            runtime: {
              inlineActive: false,
              backgroundActive: false,
            },
            request: {
              prompt: params.followupRun.prompt,
              summaryLine: params.followupRun.summaryLine,
              waitKind,
            },
          }),
        }))
      : createManagedTaskFlow({
          ownerKey: params.queueKey,
          controllerId: LIVE_TASK_CONTROLLER_ID,
          requesterOrigin: params.followupRun.run.sessionKey
            ? {
                channel: params.followupRun.originatingChannel,
                accountId: params.followupRun.originatingAccountId,
                to: params.followupRun.originatingTo,
                threadId: params.followupRun.originatingThreadId,
              }
            : undefined,
          status: "waiting",
          goal: summarizeGoal(params.followupRun),
          currentStep: "Waiting for the foreground flow to clear.",
          stateJson: buildStateJson({
            controller: {
              foreground: false,
              browserLease: false,
              leaseToken: undefined,
            },
            request: {
              prompt: params.followupRun.prompt,
              summaryLine: params.followupRun.summaryLine,
              waitKind,
            },
          }),
          waitJson: buildWaitJson({
            kind: waitKind,
            heldByFlowId: browserHolder?.flowId ?? foreground?.flowId,
            queuePosition: getFollowupQueueDepthSafe(params.queueKey) + 1,
          }),
        });
  if (!flow) {
    throw new Error("Failed to create a managed live task flow.");
  }
  applyControllerMetadata(params.followupRun, {
    flowId: flow.flowId,
    waitKind,
    skipQueuedLifecycle: true,
    browserLease: waitKind === "browser_lease",
  });
  return flow;
}

function getFollowupQueueDepthSafe(queueKey: string): number {
  return listFollowupQueueItems(queueKey).length;
}

export function beginForegroundLiveTaskFlow(params: {
  queueKey: string;
  followupRun: FollowupRun;
}): TaskFlowRecord {
  const browserLease = waitKindFromText(params.followupRun.prompt) === "browser_lease";
  const existingFlowId = params.followupRun.controller?.flowId?.trim();
  const existing =
    existingFlowId &&
    getTaskFlowByIdForOwner({ flowId: existingFlowId, callerOwnerKey: params.queueKey });
  let flow =
    existing && isManagedLiveTaskFlow(existing)
      ? updateManagedFlow(existing.flowId, (current) => ({
          status: "running",
          currentStep: "Working in the foreground conversation.",
          blockedTaskId: null,
          blockedSummary: null,
          waitJson: null,
          endedAt: null,
          stateJson: buildStateJson({
            flow: current,
            controller: {
              foreground: true,
              browserLease,
              leaseToken: browserLease
                ? normalizeControllerStateJson(current.stateJson).controller.leaseToken
                : undefined,
            },
            runtime: {
              inlineActive: true,
              backgroundActive: false,
            },
            request: {
              prompt: params.followupRun.prompt,
              summaryLine: params.followupRun.summaryLine,
              waitKind:
                params.followupRun.controller?.waitKind ??
                waitKindFromText(params.followupRun.prompt),
            },
          }),
        }))
      : createManagedTaskFlow({
          ownerKey: params.queueKey,
          controllerId: LIVE_TASK_CONTROLLER_ID,
          status: "running",
          goal: summarizeGoal(params.followupRun),
          currentStep: "Working in the foreground conversation.",
          stateJson: buildStateJson({
            controller: {
              foreground: true,
              browserLease,
              leaseToken: undefined,
            },
            runtime: {
              inlineActive: true,
              backgroundActive: false,
            },
            request: {
              prompt: params.followupRun.prompt,
              summaryLine: params.followupRun.summaryLine,
              waitKind: waitKindFromText(params.followupRun.prompt),
            },
          }),
        });
  if (!flow) {
    flow = createManagedTaskFlow({
      ownerKey: params.queueKey,
      controllerId: LIVE_TASK_CONTROLLER_ID,
      status: "running",
      goal: summarizeGoal(params.followupRun),
      currentStep: "Working in the foreground conversation.",
      stateJson: buildStateJson({
        controller: {
          foreground: true,
          browserLease,
          leaseToken: undefined,
        },
        runtime: {
          inlineActive: true,
          backgroundActive: false,
        },
        request: {
          prompt: params.followupRun.prompt,
          summaryLine: params.followupRun.summaryLine,
          waitKind: waitKindFromText(params.followupRun.prompt),
        },
      }),
    });
  }
  if (browserLease) {
    const currentState = normalizeControllerStateJson(flow.stateJson);
    const acquired = acquireTaskFlowBrowserLease({
      ownerKey: params.queueKey,
      flowId: flow.flowId,
      token: currentState.controller.leaseToken,
    });
    if (acquired.applied) {
      flow =
        updateManagedFlow(flow.flowId, (current) => ({
          stateJson: buildStateJson({
            flow: current,
            controller: {
              foreground: true,
              browserLease: true,
              leaseToken: acquired.lease.token,
            },
            runtime: {
              inlineActive: true,
              backgroundActive: false,
            },
          }),
        })) ?? flow;
    }
  } else {
    const currentState = normalizeControllerStateJson(flow.stateJson);
    if (currentState.controller.leaseToken) {
      releaseTaskFlowBrowserLease({
        flowId: flow.flowId,
        token: currentState.controller.leaseToken,
      });
      flow =
        updateManagedFlow(flow.flowId, (current) => ({
          stateJson: buildStateJson({
            flow: current,
            controller: {
              foreground: true,
              browserLease: false,
              leaseToken: undefined,
            },
          }),
        })) ?? flow;
    }
  }
  applyControllerMetadata(params.followupRun, {
    flowId: flow.flowId,
    waitKind:
      params.followupRun.controller?.waitKind ?? waitKindFromText(params.followupRun.prompt),
    skipQueuedLifecycle: true,
    browserLease,
  });
  clearManagedFlowMarkers({
    ownerKey: params.queueKey,
    keepFlowId: flow.flowId,
    clearForeground: true,
    clearBrowserLease: true,
    clearInlineRuntime: true,
  });
  return flow;
}

export function settleLiveTaskFlow(params: {
  flowId?: string;
  status: "succeeded" | "failed" | "cancelled" | "lost";
  currentStep?: string;
  blockedSummary?: string;
}): TaskFlowRecord | undefined {
  const flowId = params.flowId?.trim();
  if (!flowId) {
    return undefined;
  }
  const flow = getTaskFlowById(flowId);
  const state = flow ? normalizeControllerStateJson(flow.stateJson) : undefined;
  if (state?.controller.leaseToken) {
    releaseTaskFlowBrowserLease({
      flowId,
      token: state.controller.leaseToken,
    });
  } else if (getTaskFlowBrowserLease()?.flowId === flowId) {
    clearTaskFlowBrowserLease();
  }
  return updateManagedFlow(flowId, (current) => ({
    status: params.status,
    currentStep: params.currentStep ?? current.currentStep,
    blockedSummary: params.blockedSummary ?? null,
    blockedTaskId: null,
    waitJson: null,
    endedAt: Date.now(),
    stateJson: buildStateJson({
      flow: current,
      controller: {
        foreground: false,
        browserLease: false,
        leaseToken: undefined,
      },
      runtime: {
        inlineActive: false,
        backgroundActive: false,
      },
    }),
  }));
}

export function beginBackgroundLiveTaskFlow(params: {
  flowId?: string;
  currentStep?: string;
}): TaskFlowRecord | undefined {
  const flowId = params.flowId?.trim();
  if (!flowId) {
    return undefined;
  }
  return updateManagedFlow(flowId, (current) => ({
    status: "running",
    currentStep: params.currentStep ?? "Working in the background.",
    blockedTaskId: null,
    blockedSummary: null,
    waitJson: null,
    endedAt: null,
    stateJson: buildStateJson({
      flow: current,
      controller: {
        foreground: false,
        browserLease: false,
        leaseToken: undefined,
      },
      runtime: {
        inlineActive: false,
        backgroundActive: true,
      },
    }),
  }));
}

export function buildQueuedLiveTaskReply(params: { queueKey: string; flow: TaskFlowRecord }): {
  text: string;
} {
  const foreground = getForegroundFlowForOwner(params.queueKey);
  const reason = formatLiveTaskState(reconcileFlow(params.flow));
  const lines = [
    `Queued as flow ${formatLiveTaskHandle(params.flow)}.`,
    foreground
      ? `Foreground flow ${formatLiveTaskHandle(foreground)} is still active.`
      : "Another foreground flow is still active.",
    reason,
    `Next: ${formatLiveTaskNextPhrases(params.flow).join(" · ")}`,
  ];
  return { text: lines.join("\n") };
}

export function buildBackgroundLiveTaskAck(flow: TaskFlowRecord): { text: string } {
  const handle = formatLiveTaskHandle(flow);
  const goal = sanitizeFlowText(flow.goal, 120) || "this task";
  return {
    text: [
      `Working on ${goal} in the background as ${handle}.`,
      `Next: /tasks ${handle} · cancel ${handle}`,
    ].join("\n"),
  };
}

export function buildForegroundLiveTaskAck(flow: TaskFlowRecord): { text: string } {
  const handle = formatLiveTaskHandle(flow);
  return {
    text: [`Flow ${handle} is now running.`, `Next: /tasks ${handle}`].join("\n"),
  };
}

export function buildDidNotQueueLiveTaskReply(flow: TaskFlowRecord): { text: string } {
  return {
    text: [
      `Did not queue flow ${formatLiveTaskHandle(flow)} because an equivalent request is already pending.`,
      "Next: /tasks",
    ].join("\n"),
  };
}

export function buildBlockingLiveTaskReply(sessionKey: string): { text: string } | undefined {
  const board = resolveLiveTaskBoard(sessionKey);
  if (board.all.length === 0) {
    return undefined;
  }
  const lines: string[] = [];
  if (board.foreground) {
    lines.push(`Foreground flow ${formatLiveTaskHandle(board.foreground)} is active.`);
    lines.push(formatLiveTaskState(board.foreground));
  }
  if (board.waiting.length > 0) {
    const next = board.waiting[0];
    lines.push(`Next waiting flow: ${formatLiveTaskHandle(next)}.`);
    lines.push(formatLiveTaskState(next));
    lines.push(`Next: ${formatLiveTaskNextPhrases(next).join(" · ")}`);
  } else if (board.blocked.length > 0) {
    const blocked = board.blocked[0];
    lines.push(`Blocked flow: ${formatLiveTaskHandle(blocked)}.`);
    lines.push(formatLiveTaskState(blocked));
    lines.push(`Next: ${formatLiveTaskNextPhrases(blocked).join(" · ")}`);
  } else if (board.foreground) {
    lines.push(`Next: ${formatLiveTaskNextPhrases(board.foreground).join(" · ")}`);
  }
  return lines.length > 0 ? { text: lines.join("\n") } : undefined;
}

export function resolveLiveTaskFlow(sessionKey: string, token: string): TaskFlowRecord | undefined {
  const flow = resolveTaskFlowForLookupTokenForOwner({
    token,
    callerOwnerKey: sessionKey,
  });
  return flow && isManagedLiveTaskFlow(flow) ? reconcileFlow(flow) : undefined;
}

function promoteForegroundFlow(params: {
  sessionKey: string;
  flow: TaskFlowRecord;
}): TaskFlowRecord | undefined {
  clearManagedFlowMarkers({
    ownerKey: params.sessionKey,
    keepFlowId: params.flow.flowId,
    clearForeground: true,
  });
  return updateManagedFlow(params.flow.flowId, (current) => ({
    stateJson: buildStateJson({
      flow: current,
      controller: {
        foreground: true,
        browserLease: normalizeControllerStateJson(current.stateJson).controller.browserLease,
        leaseToken: normalizeControllerStateJson(current.stateJson).controller.leaseToken,
      },
    }),
  }));
}

function listActiveCandidateFlows(sessionKey: string): TaskFlowRecord[] {
  const board = resolveLiveTaskBoard(sessionKey);
  return board.all.filter((flow) => isActiveFlow(flow));
}

function looksLikeShortTextTurn(text: string): boolean {
  const trimmed = text.trim();
  return Boolean(trimmed) && trimmed.length <= 220 && !trimmed.includes("\n");
}

export function matchesForegroundSteer(text: string): boolean {
  return /\b(continue|resume|keep going|go ahead|finish|yes|do it|work on|focus on)\b/i.test(text);
}

export function matchesBlockingQuestion(text: string): boolean {
  return /\b(what(?:'s| is) blocking|how to clear|clear the lane|what queue|when.*clear)\b/i.test(
    text,
  );
}

export function matchesSteerContinue(text: string): boolean {
  return matchesForegroundSteer(text) && /\b(browser|warm|reply|replies)\b/i.test(text);
}

export function parseLiveTaskControlInput(text: string): LiveTaskExplicitControl | undefined {
  const match = text.trim().match(/^(continue|cancel|retry)\s+([A-Za-z0-9-]+)(?:\s+(confirm))?$/i);
  if (!match) {
    return undefined;
  }
  return {
    kind: "explicit",
    action: match[1].toLowerCase() as "continue" | "cancel" | "retry",
    token: match[2],
    confirmed: match[3]?.toLowerCase() === "confirm",
  };
}

function matchesQueueSummaryQuestion(text: string): boolean {
  return /\b((what|show|list).*(queue|queues|queued|task board|queue board|flow board)|what(?:'s| is).*(queued|queue|task board|queue board|flow board))\b/i.test(
    text,
  );
}

function matchesBulkCancelQueues(text: string): boolean {
  return /\b(cancel|kill|clear|stop)\b.*\b(all|queued|waiting|queue|queues|tasks|flows)\b/i.test(
    text,
  );
}

function matchesQueueControlLanguage(text: string): boolean {
  return /\b(queue|queues|queued|task board|queue board|flow board|flow lane|clear the lane|cancel all queues?|kill all queues?|stop all queues?)\b/i.test(
    text,
  );
}

export function classifyLiveTaskControllerIntent(params: {
  text: string;
  active?: boolean;
  explicit?: LiveTaskExplicitControl;
}): LiveTaskControllerIntent {
  const text = params.text.trim();
  if (params.explicit) {
    return params.explicit;
  }
  if (matchesQueueSummaryQuestion(text)) {
    return { kind: "queue-summary" };
  }
  if (matchesBlockingQuestion(text)) {
    return { kind: "blocking-question" };
  }
  if (matchesBulkCancelQueues(text)) {
    return { kind: "bulk-cancel-queued" };
  }
  if (matchesForegroundSteer(text) && params.active) {
    return { kind: "foreground-steer" };
  }
  if (matchesQueueControlLanguage(text)) {
    return { kind: "ambiguous-control" };
  }
  return { kind: "create" };
}

export function buildLiveTaskDisambiguationReply(sessionKey: string): { text: string } | undefined {
  const candidates = listActiveCandidateFlows(sessionKey).slice(0, 4);
  if (candidates.length <= 1) {
    return undefined;
  }
  const lines = ["I need an explicit handle before I steer anything.", "Active flows:"];
  for (const [index, flow] of candidates.entries()) {
    lines.push(`${index + 1}. ${formatFlowHeadline(flow)} · ${formatLiveTaskState(flow)}`);
  }
  lines.push("Next: continue <handle> · cancel <handle> · /tasks");
  return { text: lines.join("\n") };
}

export function maybeAttachLiveTaskAnswer(params: {
  sessionKey: string;
  followupRun: FollowupRun;
}): { attached: boolean; ambiguityReply?: { text: string } } {
  const board = resolveLiveTaskBoard(params.sessionKey);
  if (!looksLikeShortTextTurn(params.followupRun.prompt)) {
    return { attached: false };
  }
  if (board.blocked.length === 1) {
    const blocked = board.blocked[0];
    applyControllerMetadata(params.followupRun, {
      flowId: blocked.flowId,
      waitKind:
        normalizeControllerStateJson(blocked.stateJson).request?.waitKind ??
        waitKindFromText(params.followupRun.prompt),
      skipQueuedLifecycle: true,
      browserLease:
        normalizeControllerStateJson(blocked.stateJson).request?.waitKind === "browser_lease",
    });
    return { attached: true };
  }
  if (board.blocked.length > 1) {
    return {
      attached: false,
      ambiguityReply: buildLiveTaskDisambiguationReply(params.sessionKey),
    };
  }
  return { attached: false };
}

export function resolveLiveTaskControllerAction(params: {
  sessionKey: string;
  text: string;
  followupRun: FollowupRun;
  intent: LiveTaskControllerIntent;
  active?: boolean;
}):
  | {
      kind: TaskFlowControllerActionKind;
      normalizedAction: string;
      flowId?: string;
    }
  | undefined {
  const text = params.text.trim();
  if (params.intent.kind === "explicit") {
    const flow = resolveLiveTaskFlow(params.sessionKey, params.intent.token);
    return {
      kind: params.intent.action === "continue" ? "steer" : params.intent.action,
      normalizedAction: `${params.intent.action}:${params.intent.token.toLowerCase()}`,
      flowId: flow?.flowId,
    };
  }
  if (params.intent.kind === "queue-summary") {
    return {
      kind: "steer",
      normalizedAction: "inspect:queue-summary",
    };
  }
  if (params.intent.kind === "blocking-question") {
    return {
      kind: "steer",
      normalizedAction: "inspect:blocking",
    };
  }
  if (params.intent.kind === "bulk-cancel-queued") {
    return {
      kind: "cancel",
      normalizedAction: "cancel:queued",
    };
  }
  if (params.intent.kind === "ambiguous-control") {
    return {
      kind: "steer",
      normalizedAction: "clarify:control",
    };
  }
  if (params.intent.kind === "foreground-steer" && params.active) {
    const foreground = getForegroundFlowForOwner(params.sessionKey);
    if (!foreground) {
      return undefined;
    }
    return {
      kind: "steer",
      normalizedAction: `steer:${formatLiveTaskHandle(foreground)}`,
      flowId: foreground.flowId,
    };
  }
  if (looksLikeShortTextTurn(text)) {
    const blocked = resolveLiveTaskBoard(params.sessionKey).blocked;
    if (blocked.length === 1) {
      return {
        kind: "steer",
        normalizedAction: `steer:${formatLiveTaskHandle(blocked[0])}`,
        flowId: blocked[0].flowId,
      };
    }
  }
  if (params.intent.kind === "create") {
    return {
      kind: "create",
      normalizedAction: "create",
    };
  }
  return undefined;
}

export function beginLiveTaskControllerAction(params: {
  sessionKey: string;
  followupRun: FollowupRun;
  kind: TaskFlowControllerActionKind;
  normalizedAction: string;
  flowId?: string;
}):
  | {
      actionKey: string;
      replayText?: string;
      flowId?: string;
    }
  | undefined {
  const updateId = params.followupRun.messageId?.trim();
  if (!updateId) {
    return undefined;
  }
  const actionKey = buildLiveTaskControllerActionKey({
    ownerKey: params.sessionKey,
    updateId,
    normalizedAction: params.normalizedAction,
  });
  const existing = getTaskFlowControllerAction(actionKey);
  if (existing) {
    return {
      actionKey,
      replayText: buildLiveTaskControllerReplayText({
        sessionKey: params.sessionKey,
        record: existing,
      }),
      flowId: existing.flowId,
    };
  }
  const started = beginTaskFlowControllerAction({
    actionKey,
    ownerKey: params.sessionKey,
    senderId: params.followupRun.run.senderId,
    updateId,
    normalizedAction: params.normalizedAction,
    kind: params.kind,
  });
  if (params.flowId && started.record.flowId !== params.flowId) {
    updateTaskFlowControllerAction({
      actionKey,
      expectedRevision: started.record.revision,
      flowId: params.flowId,
    });
  }
  return {
    actionKey,
    flowId: params.flowId ?? started.record.flowId,
  };
}

export function completeLiveTaskControllerAction(params: {
  actionKey?: string;
  flowId?: string;
  text: string;
}): void {
  const actionKey = params.actionKey?.trim();
  if (!actionKey) {
    return;
  }
  const existing = getTaskFlowControllerAction(actionKey);
  if (!existing) {
    return;
  }
  updateTaskFlowControllerAction({
    actionKey,
    expectedRevision: existing.revision,
    flowId: params.flowId ?? existing.flowId,
    responseText: params.text,
    status: "completed",
  });
}

export function setLiveTaskControllerActionReplyText(params: {
  actionKey?: string;
  flowId?: string;
  text: string;
}): void {
  const actionKey = params.actionKey?.trim();
  if (!actionKey) {
    return;
  }
  const existing = getTaskFlowControllerAction(actionKey);
  if (!existing) {
    return;
  }
  updateTaskFlowControllerAction({
    actionKey,
    expectedRevision: existing.revision,
    flowId: params.flowId ?? existing.flowId,
    responseText: params.text,
  });
}

export function setLiveTaskControllerActionFlowId(params: {
  actionKey?: string;
  flowId: string;
}): void {
  const actionKey = params.actionKey?.trim();
  if (!actionKey) {
    return;
  }
  const existing = getTaskFlowControllerAction(actionKey);
  if (!existing || existing.flowId === params.flowId) {
    return;
  }
  updateTaskFlowControllerAction({
    actionKey,
    expectedRevision: existing.revision,
    flowId: params.flowId,
  });
}

export function buildUnauthorizedLiveTaskReply(): { text: string } {
  return {
    text: "This Telegram control lane only accepts the authorized operator.",
  };
}

export function buildLiveTaskControlClarificationReply(sessionKey: string): { text: string } {
  const boardText = buildLiveTaskBoardText({ sessionKey });
  if (boardText) {
    return {
      text: `${boardText}\n\nI read that as queue control. Next: /tasks · continue <handle> · cancel <handle> · say "cancel all queues"`,
    };
  }
  return {
    text: 'I read that as queue control, but there are no managed flows right now.\nNext: /tasks · say "draft the next reply batch"',
  };
}

export function steerForegroundLiveTask(params: {
  sessionKey: string;
  prompt: string;
  queueEmbeddedPiMessage: (sessionId: string, text: string) => boolean;
}): { text: string } | undefined {
  const flow = getForegroundFlowForOwner(params.sessionKey);
  const sessionId = resolveActiveEmbeddedRunSessionId(params.sessionKey);
  if (!flow || !sessionId) {
    return undefined;
  }
  const steered = params.queueEmbeddedPiMessage(sessionId, params.prompt);
  if (!steered) {
    return undefined;
  }
  return {
    text: [
      `Steered foreground flow ${formatLiveTaskHandle(flow)}.`,
      `Next: ${formatLiveTaskNextPhrases(flow).join(" · ")}`,
    ].join("\n"),
  };
}

export function continueLiveTaskFlow(params: {
  sessionKey: string;
  flow: TaskFlowRecord;
}): { text: string } | undefined {
  if (
    params.flow.status !== "running" &&
    params.flow.status !== "queued" &&
    params.flow.status !== "waiting"
  ) {
    return undefined;
  }
  const updated = promoteForegroundFlow(params) ?? params.flow;
  const reconciled = reconcileFlow(updated);
  return {
    text: [
      `Flow ${formatLiveTaskHandle(reconciled)} is now the foreground flow.`,
      `State: ${formatLiveTaskState(reconciled)}`,
      `Next: ${formatLiveTaskNextPhrases(reconciled).join(" · ")}`,
    ].join("\n"),
  };
}

export function buildLiveTaskHandleStatusReply(flow: TaskFlowRecord): { text: string } {
  return {
    text: [
      `Flow ${formatLiveTaskHandle(flow)} is ${flow.status.replaceAll("_", " ")}.`,
      `State: ${formatLiveTaskState(flow)}`,
      `Next: ${formatLiveTaskNextPhrases(flow).join(" · ")}`,
    ].join("\n"),
  };
}

export function cancelLiveTaskFlow(params: {
  sessionKey: string;
  flow: TaskFlowRecord;
  confirmed?: boolean;
}): { text: string } {
  const handle = formatLiveTaskHandle(params.flow);
  removeFollowupQueueItems(
    params.sessionKey,
    (item) => item.controller?.flowId === params.flow.flowId,
  );
  const state = normalizeControllerStateJson(params.flow.stateJson);
  if (
    !params.confirmed &&
    state.controller.foreground &&
    state.controller.browserLease &&
    params.flow.status === "running"
  ) {
    return {
      text: [
        `Flow ${handle} is actively holding the live browser.`,
        `Reply "cancel ${handle} confirm" to interrupt it.`,
        `Next: /tasks ${handle}`,
      ].join("\n"),
    };
  }
  if (state.controller.foreground) {
    replyRunRegistry.abort(params.sessionKey);
    const sessionId = resolveActiveEmbeddedRunSessionId(params.sessionKey);
    if (sessionId) {
      abortEmbeddedPiRun(sessionId);
    }
  }
  settleLiveTaskFlow({
    flowId: params.flow.flowId,
    status: "cancelled",
  });
  return {
    text: `Cancelled flow ${handle}.\nNext: /tasks`,
  };
}

export function cancelQueuedLiveTaskFlows(params: { sessionKey: string }): {
  text: string;
  cancelledFlowIds: string[];
  preservedForegroundFlowId?: string;
} {
  const board = resolveLiveTaskBoard(params.sessionKey);
  const preservedForegroundFlowId = board.foreground?.flowId;
  const cancellable = board.all.filter((flow) => {
    if (!isActiveFlow(flow)) {
      return false;
    }
    if (flow.flowId === preservedForegroundFlowId) {
      return false;
    }
    return flow.status === "queued" || flow.status === "waiting" || flow.status === "blocked";
  });

  for (const flow of cancellable) {
    removeFollowupQueueItems(params.sessionKey, (item) => item.controller?.flowId === flow.flowId);
    settleLiveTaskFlow({
      flowId: flow.flowId,
      status: "cancelled",
    });
  }

  const summaryParts = [
    `Cancelled ${cancellable.length} queued, waiting, or blocked flow${cancellable.length === 1 ? "" : "s"}.`,
  ];
  if (preservedForegroundFlowId) {
    summaryParts.push(
      `Kept foreground flow ${formatLiveTaskHandle({ flowId: preservedForegroundFlowId })} running.`,
    );
  } else {
    summaryParts.push("There was no active foreground flow to preserve.");
  }
  summaryParts.push("Next: /tasks");

  return {
    text: summaryParts.join("\n"),
    cancelledFlowIds: cancellable.map((flow) => flow.flowId),
    preservedForegroundFlowId,
  };
}

export function buildFollowupRunFromFlow(params: {
  flow: TaskFlowRecord;
  template: FollowupRun;
}): FollowupRun {
  const state = normalizeControllerStateJson(params.flow.stateJson);
  const prompt = state.request?.prompt?.trim() || params.flow.goal;
  const run = {
    ...params.template,
    prompt,
    summaryLine: state.request?.summaryLine ?? params.flow.goal,
    enqueuedAt: Date.now(),
  };
  return applyControllerMetadata(run, {
    flowId: params.flow.flowId,
    waitKind: state.request?.waitKind ?? waitKindFromText(prompt),
    skipQueuedLifecycle: true,
    browserLease: state.request?.waitKind === "browser_lease",
  });
}

export function queueLiveTaskFlowForRetry(params: {
  sessionKey: string;
  flow: TaskFlowRecord;
  template: FollowupRun;
  enqueueFollowupRun: (run: FollowupRun) => boolean;
}): { text: string } {
  const next = buildFollowupRunFromFlow({
    flow: params.flow,
    template: params.template,
  });
  const updated = updateManagedFlow(params.flow.flowId, (flow) => ({
    status: "waiting",
    currentStep: "Waiting for the foreground flow to clear.",
    blockedTaskId: null,
    blockedSummary: null,
    endedAt: null,
    waitJson: buildWaitJson({
      kind:
        normalizeControllerStateJson(flow.stateJson).request?.waitKind ??
        waitKindFromText(next.prompt),
      heldByFlowId: getForegroundFlowForOwner(params.sessionKey)?.flowId,
      queuePosition: getFollowupQueueDepthSafe(params.sessionKey) + 1,
    }),
    stateJson: buildStateJson({
      flow,
      controller: {
        foreground: false,
        browserLease: false,
        leaseToken: undefined,
      },
      runtime: {
        inlineActive: false,
        backgroundActive: false,
      },
    }),
  }));
  const enqueued = params.enqueueFollowupRun(next);
  const handle = formatLiveTaskHandle(updated ?? params.flow);
  if (!enqueued) {
    settleLiveTaskFlow({
      flowId: params.flow.flowId,
      status: "cancelled",
      blockedSummary: "The flow was not queued because an equivalent request was already pending.",
    });
    return {
      text: `Did not queue flow ${handle} because an equivalent request is already pending.\nNext: /tasks ${handle}`,
    };
  }
  return {
    text: `Queued flow ${handle} to continue.\nNext: ${formatLiveTaskNextPhrases(updated ?? params.flow).join(" · ")}`,
  };
}
