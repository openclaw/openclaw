import { loadConfig } from "../../config/config.js";
import { listTasksForFlowId } from "../../tasks/runtime-internal.js";
import { mapTaskFlowDetail } from "../../tasks/task-domain-views.js";
import {
  cancelFlowByIdForOwner,
  getFlowTaskSummary,
  retryManagedChildTaskFlowForOwner,
} from "../../tasks/task-executor.js";
import {
  findLatestTaskFlowForOwner,
  getTaskFlowByIdForOwner,
} from "../../tasks/task-flow-owner-access.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function readRequiredString(value: unknown, field: string, respond: RespondFn): string | null {
  if (typeof value !== "string" || !value.trim()) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `${field} required`));
    return null;
  }
  return value.trim();
}

function mapFlowDetailForOwner(params: { flowId: string; ownerKey: string }) {
  const flow = getTaskFlowByIdForOwner({
    flowId: params.flowId,
    callerOwnerKey: params.ownerKey,
  });
  if (!flow) {
    return undefined;
  }
  const tasks = listTasksForFlowId(flow.flowId);
  return mapTaskFlowDetail({
    flow,
    tasks,
    summary: getFlowTaskSummary(flow.flowId),
  });
}

export const taskHandlers: GatewayRequestHandlers = {
  "tasks.flows.findLatest": ({ params, respond }) => {
    const sessionKey = readRequiredString(params.sessionKey, "sessionKey", respond);
    if (!sessionKey) {
      return;
    }
    const flow = findLatestTaskFlowForOwner({ callerOwnerKey: sessionKey });
    if (!flow) {
      respond(true, { flow: null });
      return;
    }
    respond(true, {
      flow: mapFlowDetailForOwner({ flowId: flow.flowId, ownerKey: sessionKey }) ?? null,
    });
  },

  "tasks.flows.cancel": async ({ params, respond }) => {
    const sessionKey = readRequiredString(params.sessionKey, "sessionKey", respond);
    if (!sessionKey) {
      return;
    }
    const flowId = readRequiredString(params.flowId, "flowId", respond);
    if (!flowId) {
      return;
    }
    const result = await cancelFlowByIdForOwner({
      cfg: loadConfig(),
      flowId,
      callerOwnerKey: sessionKey,
    });
    respond(true, {
      found: result.found,
      cancelled: result.cancelled,
      ...(result.reason ? { reason: result.reason } : {}),
      flow: mapFlowDetailForOwner({ flowId, ownerKey: sessionKey }) ?? null,
    });
  },

  "tasks.flows.retry": async ({ params, respond }) => {
    const sessionKey = readRequiredString(params.sessionKey, "sessionKey", respond);
    if (!sessionKey) {
      return;
    }
    const flowId = readRequiredString(params.flowId, "flowId", respond);
    if (!flowId) {
      return;
    }
    const result = await retryManagedChildTaskFlowForOwner({
      flowId,
      callerOwnerKey: sessionKey,
    });
    respond(true, {
      found: result.found,
      retried: result.retried,
      ...(result.reason ? { reason: result.reason } : {}),
      flow: mapFlowDetailForOwner({ flowId, ownerKey: sessionKey }) ?? null,
    });
  },
};
