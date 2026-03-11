import { ZodError } from "zod";
import { compileOperatorAgentRegistry } from "../../operator-control/agent-registry.js";
import { syncOperatorTaskToDeb } from "../../operator-control/deb-sync.js";
import {
  dispatchOperatorTask,
  submitOperatorTaskAndDispatch,
} from "../../operator-control/dispatch.js";
import {
  listOperatorMemory,
  promoteOperatorMemory,
  upsertOperatorServiceContext,
  type OperatorMemoryCollection,
} from "../../operator-control/memory-store.js";
import { getOperatorControlStatus } from "../../operator-control/operator-status.js";
import {
  applyOperatorExternalReceipt,
  getOperatorTask,
  listOperatorTasks,
  patchOperatorTask,
  type OperatorTaskListFilters,
} from "../../operator-control/task-store.js";
import {
  cancelOperatorWorkerTask,
  getOperatorWorkerReady,
  getOperatorWorkerTask,
  getOperatorWorkerTaskEvents,
  isOperatorWorkerClientError,
  listOperatorWorkerTasks,
} from "../../operator-control/worker-client.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toTaskId(value: unknown): string | null {
  return asString(value);
}

function toLimit(value: unknown, fallback: number): number {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(200, Math.max(1, Math.round(raw)));
}

function toMemoryCollection(value: unknown): OperatorMemoryCollection | null {
  return asString(value) as OperatorMemoryCollection | null;
}

export const operatorControlHandlers: GatewayRequestHandlers = {
  "operator.status": ({ respond }) => {
    respond(true, getOperatorControlStatus());
  },

  "operator.registry.get": ({ respond }) => {
    respond(true, compileOperatorAgentRegistry());
  },

  "operator.memory.list": ({ respond, params }) => {
    respond(
      true,
      listOperatorMemory({
        collection: toMemoryCollection(params.collection),
        limit: toLimit(params.limit, 50),
      }),
    );
  },

  "operator.memory.promote": ({ respond, params }) => {
    try {
      const payload = promoteOperatorMemory(params);
      respond(true, payload, undefined, { created: payload.created });
    } catch (error) {
      if (error instanceof ZodError) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid operator.memory.promote params: ${error.message}`,
          ),
        );
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "operator.memory.promote failed",
        ),
      );
    }
  },

  "operator.memory.upsertServiceContext": ({ respond, params }) => {
    try {
      const payload = upsertOperatorServiceContext(params);
      respond(true, payload, undefined, { created: payload.created });
    } catch (error) {
      if (error instanceof ZodError) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid operator.memory.upsertServiceContext params: ${error.message}`,
          ),
        );
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "operator.memory.upsertServiceContext failed",
        ),
      );
    }
  },

  "operator.tasks.list": ({ respond, params }) => {
    const payload = listOperatorTasks({
      state: asString(params.state) as OperatorTaskListFilters["state"],
      tier: asString(params.tier) as OperatorTaskListFilters["tier"],
      capability: asString(params.capability),
      limit: toLimit(params.limit, 50),
    });
    respond(true, payload);
  },

  "operator.tasks.get": ({ respond, params }) => {
    const taskId = toTaskId(params.taskId ?? params.task_id ?? params.id);
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId required"));
      return;
    }
    const task = getOperatorTask(taskId);
    if (!task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown taskId: ${taskId}`),
      );
      return;
    }
    respond(true, task);
  },

  "operator.tasks.submit": async ({ respond, params }) => {
    try {
      const payload = await submitOperatorTaskAndDispatch(params);
      await syncOperatorTaskToDeb(payload.task, "submit");
      respond(true, payload, undefined, { created: payload.created });
    } catch (error) {
      if (error instanceof ZodError) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid operator.tasks.submit params: ${error.message}`,
          ),
        );
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "operator.tasks.submit failed",
        ),
      );
    }
  },

  "operator.tasks.dispatch": async ({ respond, params }) => {
    const taskId = toTaskId(params.taskId ?? params.task_id ?? params.id);
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId required"));
      return;
    }
    try {
      const payload = await dispatchOperatorTask(taskId);
      respond(true, payload);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "operator.tasks.dispatch failed",
        ),
      );
    }
  },

  "operator.tasks.receipt": async ({ respond, params }) => {
    const taskId = toTaskId(params.taskId ?? params.task_id ?? params.id);
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId required"));
      return;
    }
    try {
      const task = applyOperatorExternalReceipt(taskId, params.receipt ?? params);
      if (!task) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown taskId: ${taskId}`),
        );
        return;
      }
      await syncOperatorTaskToDeb(task, "receipt");
      respond(true, task);
    } catch (error) {
      if (error instanceof ZodError) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid operator.tasks.receipt params: ${error.message}`,
          ),
        );
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "operator.tasks.receipt failed",
        ),
      );
    }
  },

  "operator.tasks.patch": async ({ respond, params }) => {
    const taskId = toTaskId(params.taskId ?? params.task_id ?? params.id);
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId required"));
      return;
    }
    try {
      const task = patchOperatorTask(taskId, params.patch ?? params);
      if (!task) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown taskId: ${taskId}`),
        );
        return;
      }
      await syncOperatorTaskToDeb(task, "patch");
      respond(true, task);
    } catch (error) {
      if (error instanceof ZodError) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid operator.tasks.patch params: ${error.message}`,
          ),
        );
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "operator.tasks.patch failed",
        ),
      );
    }
  },

  "operator.worker.tasks.list": async ({ respond, params }) => {
    try {
      respond(true, await listOperatorWorkerTasks(toLimit(params.limit, 50)));
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          isOperatorWorkerClientError(error)
            ? error.message
            : error instanceof Error
              ? error.message
              : "operator.worker.tasks.list failed",
        ),
      );
    }
  },

  "operator.worker.ready": async ({ respond }) => {
    try {
      respond(true, await getOperatorWorkerReady());
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          isOperatorWorkerClientError(error)
            ? error.message
            : error instanceof Error
              ? error.message
              : "operator.worker.ready failed",
        ),
      );
    }
  },

  "operator.worker.tasks.get": async ({ respond, params }) => {
    const taskId = toTaskId(params.taskId ?? params.task_id ?? params.id);
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId required"));
      return;
    }
    try {
      respond(true, await getOperatorWorkerTask(taskId));
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          isOperatorWorkerClientError(error)
            ? error.message
            : error instanceof Error
              ? error.message
              : "operator.worker.tasks.get failed",
        ),
      );
    }
  },

  "operator.worker.tasks.events": async ({ respond, params }) => {
    const taskId = toTaskId(params.taskId ?? params.task_id ?? params.id);
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId required"));
      return;
    }
    try {
      respond(true, await getOperatorWorkerTaskEvents(taskId));
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          isOperatorWorkerClientError(error)
            ? error.message
            : error instanceof Error
              ? error.message
              : "operator.worker.tasks.events failed",
        ),
      );
    }
  },

  "operator.worker.tasks.cancel": async ({ respond, params }) => {
    const taskId = toTaskId(params.taskId ?? params.task_id ?? params.id);
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId required"));
      return;
    }
    try {
      respond(true, await cancelOperatorWorkerTask(taskId));
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          isOperatorWorkerClientError(error)
            ? error.message
            : error instanceof Error
              ? error.message
              : "operator.worker.tasks.cancel failed",
        ),
      );
    }
  },
};
