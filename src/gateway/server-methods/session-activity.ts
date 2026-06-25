import type { TaskRecord } from "../../tasks/task-registry.types.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsActivityParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getSessionActivitySnapshot } from "../session-activity.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function isActiveTask(task: TaskRecord): task is TaskRecord & { status: "queued" | "running" } {
  return task.status === "queued" || task.status === "running";
}

function mapActiveTask(task: TaskRecord) {
  return {
    id: task.taskId,
    sessionKey: task.requesterSessionKey,
    runtime: task.runtime,
    title: task.task,
    status: task.status,
    createdAt: task.createdAt,
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.lastEventAt !== undefined ? { lastEventAt: task.lastEventAt } : {}),
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.label ? { label: task.label } : {}),
    ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
  };
}

export const sessionActivityHandlers: GatewayRequestHandlers = {
  "sessions.activity": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsActivityParams, "sessions.activity", respond)) {
      return;
    }
    const key = params.key.trim();
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
      return;
    }
    const activity = getSessionActivitySnapshot({
      key,
      includeDescendants: params.includeDescendants,
    });
    const tasks = activity.tasks.filter(isActiveTask).map(mapActiveTask);
    respond(true, {
      key,
      revision: activity.revision,
      includedSessionKeys: activity.includedSessionKeys,
      truncated: activity.truncated,
      tasks,
      tools: activity.tools,
    });
  },
};
