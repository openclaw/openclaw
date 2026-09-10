import {
  ErrorCodes,
  errorShape,
  validateTasksHistoryParams,
  validateTasksHistoryResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { getTaskById } from "../../tasks/runtime-internal.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import {
  canAccessTaskRequesterSession,
  resolveTaskRequesterSessionTarget,
} from "../task-session-access.js";
import { allowProcessHomeFallback } from "./session-catalog-provider-access.js";
import { resolveTaskHistoryProvider } from "./task-history-provider.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

const MAX_TASK_HISTORY_PAGE_BYTES = 20 * 1024 * 1024;

function taskHistoryIdentity(task: TaskRecord): string {
  return JSON.stringify([
    task.taskId,
    task.taskKind,
    task.runtime,
    task.runId,
    task.ownerKey,
    task.requesterSessionKey,
    task.requesterAgentId,
    task.agentId,
    task.childSessionKey,
  ]);
}

export const taskHistoryHandler: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
}) => {
  if (!assertValidParams(params, validateTasksHistoryParams, "tasks.history", respond)) {
    return;
  }
  const cfg = context.getRuntimeConfig();
  const task = getTaskById(params.taskId);
  const unavailable = () =>
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Task history is unavailable"),
    );
  if (!task || !canAccessTaskRequesterSession({ cfg, client, task })) {
    unavailable();
    return;
  }
  const provider = resolveTaskHistoryProvider(task);
  const reader = provider?.taskHistory;
  if (!reader || !task.taskKind) {
    unavailable();
    return;
  }
  const identity = taskHistoryIdentity(task);
  try {
    const page = await reader.read({
      taskId: task.taskId,
      taskKind: task.taskKind,
      runId: task.runId,
      requesterSessionKey: task.requesterSessionKey,
      requesterAgentId: resolveTaskRequesterSessionTarget(task)?.agentId,
      agentId: task.agentId,
      ownerKey: task.ownerKey,
      cursor: params.cursor,
      limit: params.limit ?? 100,
      allowProcessHomeFallback: allowProcessHomeFallback(context.logGateway),
    });
    const latest = getTaskById(task.taskId);
    // Reads may outlive sharing changes, task deletion, config reload or plugin retirement.
    // Never return bytes selected under an owner that is no longer current.
    if (
      context.getRuntimeConfig() !== cfg ||
      !latest ||
      taskHistoryIdentity(latest) !== identity ||
      resolveTaskHistoryProvider(latest) !== provider ||
      !canAccessTaskRequesterSession({ cfg, client, task: latest })
    ) {
      unavailable();
      return;
    }
    const result = {
      taskId: task.taskId,
      items: page.items
        .filter((item) => item.type !== "reasoning")
        .map(({ raw: _raw, ...item }) => item),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
    if (
      !validateTasksHistoryResult(result) ||
      result.items.length > (params.limit ?? 100) ||
      Buffer.byteLength(JSON.stringify(result)) > MAX_TASK_HISTORY_PAGE_BYTES
    ) {
      unavailable();
      return;
    }
    respond(true, result);
  } catch {
    // Provider errors may carry local source paths or native connection details.
    unavailable();
  }
};
