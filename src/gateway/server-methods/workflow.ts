import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import {
  createWorkflowStoreManager,
  isValidPlanId,
  type WorkflowStoreManager,
} from "../../workflow/store.js";
import type {
  WorkflowPlan,
  WorkflowPlanCreate,
  WorkflowPlanPatch,
  WorkflowTaskUpdate,
} from "../../workflow/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function getWorkflowManager(agentId?: string): WorkflowStoreManager {
  const effectiveAgentId = agentId ?? resolveDefaultAgentId(loadConfig());
  return createWorkflowStoreManager(effectiveAgentId);
}

function isValidPlanCreate(params: unknown): params is WorkflowPlanCreate {
  if (!params || typeof params !== "object") {
    return false;
  }
  const p = params as Record<string, unknown>;
  return (
    typeof p.title === "string" &&
    Array.isArray(p.tasks) &&
    p.tasks.every(
      (t: unknown) =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as Record<string, unknown>).content === "string",
    )
  );
}

function isValidTaskUpdate(params: unknown): params is WorkflowTaskUpdate {
  if (!params || typeof params !== "object") {
    return false;
  }
  const p = params as Record<string, unknown>;
  return (
    typeof p.planId === "string" &&
    isValidPlanId(p.planId) &&
    typeof p.taskId === "string" &&
    typeof p.status === "string" &&
    ["pending", "in_progress", "completed", "skipped", "failed"].includes(p.status)
  );
}

export const workflowHandlers: GatewayRequestHandlers = {
  "workflow.list": async ({ params, respond }) => {
    const p = params as {
      agentId?: string;
      scope?: "active" | "history" | "all";
      limit?: number;
      offset?: number;
    };
    const manager = getWorkflowManager(p.agentId);
    const scope = p.scope ?? "active";
    const limit = p.limit ?? 50;
    const offset = p.offset ?? 0;

    try {
      let activePlans: WorkflowPlan[] = [];
      let historyPlans: WorkflowPlan[] = [];
      let historyTotal = 0;

      if (scope === "active" || scope === "all") {
        activePlans = await manager.getActivePlans();
      }

      if (scope === "history" || scope === "all") {
        const history = await manager.listHistory({ limit, offset });
        historyPlans = history.plans;
        historyTotal = history.total;
      }

      respond(true, {
        activePlans: scope === "history" ? [] : activePlans,
        historyPlans: scope === "active" ? [] : historyPlans,
        historyTotal,
        limit,
        offset,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to list workflows: ${String(err)}`),
      );
    }
  },

  "workflow.get": async ({ params, respond }) => {
    const p = params as {
      agentId?: string;
      planId: string;
      scope?: "active" | "history";
    };

    if (!p.planId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing planId"));
      return;
    }

    if (!isValidPlanId(p.planId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid planId format"));
      return;
    }

    const manager = getWorkflowManager(p.agentId);
    const scope = p.scope ?? "active";

    try {
      let plan: WorkflowPlan | null = null;

      if (scope === "active") {
        plan = await manager.getActivePlan(p.planId);
      } else {
        plan = await manager.getHistoryPlan(p.planId);
      }

      if (!plan) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `plan not found: ${p.planId}`));
        return;
      }

      respond(true, { plan });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to get workflow: ${String(err)}`),
      );
    }
  },

  "workflow.create": async ({ params, respond }) => {
    const p = params as WorkflowPlanCreate & { agentId?: string };

    if (!isValidPlanCreate(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid workflow create params: requires title and tasks array",
        ),
      );
      return;
    }

    const manager = getWorkflowManager(p.agentId);

    try {
      const plan = await manager.createPlan({
        agentId: p.agentId ?? resolveDefaultAgentId(loadConfig()),
        sessionKey: p.sessionKey,
        title: p.title,
        description: p.description,
        source: p.source ?? "manual",
        tasks: p.tasks,
        metadata: p.metadata,
      });

      respond(true, { plan });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to create workflow: ${String(err)}`),
      );
    }
  },

  "workflow.update": async ({ params, respond }) => {
    const p = params as {
      agentId?: string;
      planId: string;
      patch: WorkflowPlanPatch;
    };

    if (!p.planId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing planId"));
      return;
    }

    if (!isValidPlanId(p.planId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid planId format"));
      return;
    }

    const manager = getWorkflowManager(p.agentId);

    try {
      const plan = await manager.updatePlan(p.planId, p.patch ?? {});

      if (!plan) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `plan not found: ${p.planId}`));
        return;
      }

      respond(true, { plan });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to update workflow: ${String(err)}`),
      );
    }
  },

  "workflow.task.update": async ({ params, respond }) => {
    const p = params as WorkflowTaskUpdate & { agentId?: string };

    if (!isValidTaskUpdate(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid task update params: requires planId, taskId, and valid status",
        ),
      );
      return;
    }

    const manager = getWorkflowManager(p.agentId);

    try {
      const plan = await manager.updateTask({
        planId: p.planId,
        taskId: p.taskId,
        status: p.status,
        result: p.result,
        error: p.error,
      });

      if (!plan) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `plan or task not found`));
        return;
      }

      respond(true, { plan });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to update task: ${String(err)}`),
      );
    }
  },

  "workflow.task.start": async ({ params, respond }) => {
    const p = params as {
      agentId?: string;
      planId: string;
      taskId: string;
    };

    if (!p.planId || !p.taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing planId or taskId"));
      return;
    }

    if (!isValidPlanId(p.planId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid planId format"));
      return;
    }

    const manager = getWorkflowManager(p.agentId);

    try {
      const plan = await manager.startTask(p.planId, p.taskId);

      if (!plan) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `plan or task not found`));
        return;
      }

      respond(true, { plan });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to start task: ${String(err)}`),
      );
    }
  },

  "workflow.complete": async ({ params, respond }) => {
    const p = params as {
      agentId?: string;
      planId: string;
      status?: "completed" | "failed";
    };

    if (!p.planId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing planId"));
      return;
    }

    if (!isValidPlanId(p.planId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid planId format"));
      return;
    }

    const manager = getWorkflowManager(p.agentId);

    try {
      const plan = await manager.completePlan(p.planId, p.status ?? "completed");

      if (!plan) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `plan not found: ${p.planId}`));
        return;
      }

      respond(true, { plan });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to complete workflow: ${String(err)}`),
      );
    }
  },

  "workflow.delete": async ({ params, respond }) => {
    const p = params as {
      agentId?: string;
      planId: string;
    };

    if (!p.planId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing planId"));
      return;
    }

    if (!isValidPlanId(p.planId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid planId format"));
      return;
    }

    const manager = getWorkflowManager(p.agentId);

    try {
      const deleted = await manager.deletePlan(p.planId);

      if (!deleted) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `plan not found: ${p.planId}`));
        return;
      }

      respond(true, { deleted: true });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to delete workflow: ${String(err)}`),
      );
    }
  },
};
