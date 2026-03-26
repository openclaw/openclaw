import { logActivity } from "../../orchestration/activity-log-sqlite.js";
import * as RoutineStore from "../../orchestration/routine-store-sqlite.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

// Params shapes inferred inline — no protocol/schema/types.ts entries yet for routines.
type RoutinesListParams = { workspaceId: string };
type RoutinesGetParams = { id: string };
type RoutinesCreateParams = {
  workspaceId: string;
  title: string;
  description?: string;
  assigneeAgentId: string;
  projectId?: string;
  goalId?: string;
  parentIssueId?: string;
  priority?: string;
  concurrencyPolicy?: string;
  catchUpPolicy?: string;
};
type RoutinesUpdateParams = {
  id: string;
  title?: string;
  description?: string;
  assigneeAgentId?: string;
  priority?: string;
  status?: string;
  concurrencyPolicy?: string;
  catchUpPolicy?: string;
};
type RoutinesDeleteParams = { id: string };
type RoutinesTriggersListParams = { routineId: string };
type RoutinesTriggersCreateParams = {
  routineId: string;
  kind: string;
  label?: string;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
};
type RoutinesTriggersDeleteParams = { id: string };
type RoutinesRunsListParams = { routineId: string; limit?: number };
type RoutinesRunsGetParams = { id: string };

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

export const routinesHandlers: GatewayRequestHandlers = {
  "routines.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as RoutinesListParams;
      const routines = RoutineStore.listRoutines(p.workspaceId);
      respond(true, { routines });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "routines.get": async ({ params, respond }) => {
    try {
      const p = params as unknown as RoutinesGetParams;
      const routine = RoutineStore.getRoutine(p.id);
      if (!routine) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Routine not found"));
        return;
      }
      respond(true, routine);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "routines.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as RoutinesCreateParams;
      const routine = RoutineStore.createRoutine({
        workspaceId: p.workspaceId,
        title: p.title,
        description: p.description,
        assigneeAgentId: p.assigneeAgentId,
        projectId: p.projectId,
        goalId: p.goalId,
        parentIssueId: p.parentIssueId,
        priority: p.priority,
        concurrencyPolicy: p.concurrencyPolicy,
        catchUpPolicy: p.catchUpPolicy,
      });
      logActivity({
        workspaceId: p.workspaceId,
        entityType: "routine",
        entityId: routine.id,
        action: "created",
        details: { title: routine.title, assigneeAgentId: routine.assigneeAgentId },
      });
      respond(true, routine);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "routines.update": async ({ params, respond }) => {
    try {
      const p = params as unknown as RoutinesUpdateParams;
      const existing = RoutineStore.getRoutine(p.id);
      if (!existing) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Routine not found"));
        return;
      }
      const updated = RoutineStore.updateRoutine(p.id, {
        title: p.title,
        description: p.description,
        assigneeAgentId: p.assigneeAgentId,
        priority: p.priority,
        status: p.status,
        concurrencyPolicy: p.concurrencyPolicy,
        catchUpPolicy: p.catchUpPolicy,
      });
      logActivity({
        workspaceId: existing.workspaceId,
        entityType: "routine",
        entityId: p.id,
        action: "updated",
        details: { title: existing.title },
      });
      respond(true, updated);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "routines.delete": async ({ params, respond }) => {
    try {
      const p = params as unknown as RoutinesDeleteParams;
      const existing = RoutineStore.getRoutine(p.id);
      RoutineStore.deleteRoutine(p.id);
      if (existing) {
        logActivity({
          workspaceId: existing.workspaceId,
          entityType: "routine",
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

  "routines.triggers.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as RoutinesTriggersListParams;
      const triggers = RoutineStore.listRoutineTriggers(p.routineId);
      respond(true, { triggers });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "routines.triggers.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as RoutinesTriggersCreateParams;
      // Need workspaceId from the parent routine
      const routine = RoutineStore.getRoutine(p.routineId);
      if (!routine) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Routine not found"));
        return;
      }
      const trigger = RoutineStore.createRoutineTrigger({
        workspaceId: routine.workspaceId,
        routineId: p.routineId,
        kind: p.kind,
        label: p.label,
        cronExpression: p.cronExpression,
        timezone: p.timezone,
        enabled: p.enabled,
      });
      respond(true, trigger);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "routines.triggers.delete": async ({ params, respond }) => {
    try {
      const p = params as unknown as RoutinesTriggersDeleteParams;
      RoutineStore.deleteRoutineTrigger(p.id);
      respond(true, { ok: true });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "routines.runs.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as RoutinesRunsListParams;
      const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 50;
      const runs = RoutineStore.listRoutineRuns(p.routineId, limit);
      respond(true, { runs });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "routines.runs.get": async ({ params, respond }) => {
    try {
      const p = params as unknown as RoutinesRunsGetParams;
      const run = RoutineStore.getRoutineRun(p.id);
      if (!run) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Routine run not found"));
        return;
      }
      respond(true, run);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
