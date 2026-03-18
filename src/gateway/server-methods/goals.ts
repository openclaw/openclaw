import { logActivity } from "../../orchestration/activity-log-sqlite.js";
import * as GoalStore from "../../orchestration/goal-store-sqlite.js";
import type { Goal, GoalLevel, GoalStatus } from "../../orchestration/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type {
  GoalsListParams,
  GoalsGetParams,
  GoalsCreateParams,
  GoalsUpdateParams,
  GoalsDeleteParams,
} from "../protocol/schema/types.js";
import type { GatewayRequestHandlers } from "./types.js";

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

export const goalsHandlers: GatewayRequestHandlers = {
  "goals.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as GoalsListParams;
      const goals = GoalStore.listGoals({
        workspaceId: p.workspaceId,
        status: p.status as GoalStatus | undefined,
        parentId: p.parentId,
      });
      respond(true, { goals });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "goals.tree": async ({ params, respond }) => {
    try {
      const p = params as unknown as GoalsListParams;
      const goals = GoalStore.listGoals({ workspaceId: p.workspaceId });
      // Build adjacency tree in-memory
      type GoalNode = Goal & { children: GoalNode[] };
      const byId = new Map<string, GoalNode>();
      for (const g of goals) {
        byId.set(g.id, { ...g, children: [] });
      }
      const roots: GoalNode[] = [];
      for (const node of byId.values()) {
        if (node.parentId) {
          byId.get(node.parentId)?.children.push(node);
        } else {
          roots.push(node);
        }
      }
      respond(true, { tree: roots });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "goals.get": async ({ params, respond }) => {
    try {
      const p = params as unknown as GoalsGetParams;
      const goal = GoalStore.getGoal(p.id);
      if (!goal) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Goal not found"));
        return;
      }
      respond(true, goal);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "goals.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as GoalsCreateParams;
      const goal = GoalStore.createGoal({
        workspaceId: p.workspaceId,
        title: p.title,
        description: p.description,
        parentId: p.parentId,
        level: p.level as GoalLevel | undefined,
        ownerAgentId: p.ownerAgentId,
      });
      logActivity({
        workspaceId: p.workspaceId,
        entityType: "goal",
        entityId: goal.id,
        action: "created",
        details: { title: goal.title },
      });
      respond(true, goal);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "goals.update": async ({ params, respond }) => {
    try {
      const p = params as unknown as GoalsUpdateParams;
      const goal = GoalStore.updateGoal(p.id, {
        title: p.title,
        description: p.description,
        status: p.status as GoalStatus | undefined,
        level: p.level as GoalLevel | undefined,
        progress: p.progress,
        ownerAgentId: p.ownerAgentId,
        parentId: p.parentId,
      });
      const existingGoal = GoalStore.getGoal(p.id);
      if (existingGoal) {
        logActivity({
          workspaceId: existingGoal.workspaceId,
          entityType: "goal",
          entityId: p.id,
          action: "updated",
          details: { title: existingGoal.title },
        });
      }
      respond(true, goal);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "goals.delete": async ({ params, respond }) => {
    try {
      const p = params as unknown as GoalsDeleteParams;
      const existing = GoalStore.getGoal(p.id);
      GoalStore.deleteGoal(p.id);
      if (existing) {
        logActivity({
          workspaceId: existing.workspaceId,
          entityType: "goal",
          entityId: p.id,
          action: "deleted",
          details: { title: existing.title },
        });
      }
      respond(true, { ok: true });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
