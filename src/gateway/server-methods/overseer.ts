import crypto from "node:crypto";

import { loadConfig } from "../../config/config.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { loadSessionEntry } from "../session-utils.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateOverseerGoalCreateParams,
  validateOverseerGoalStatusParams,
  validateOverseerGoalUpdateParams,
  validateOverseerStatusParams,
  validateOverseerTickParams,
  validateOverseerWorkUpdateParams,
} from "../protocol/index.js";
import type {
  OverseerGoalCreateParams,
  OverseerGoalCreateResult,
  OverseerGoalUpdateParams,
  OverseerStatusResult,
  OverseerTickParams,
  OverseerWorkUpdateParams,
} from "../protocol/index.js";
import { generateOverseerPlan } from "../../infra/overseer/planner.js";
import { updateOverseerStore, loadOverseerStoreFromDisk } from "../../infra/overseer/store.js";
import { appendOverseerEvent } from "../../infra/overseer/events.js";
import type {
  OverseerAssignmentRecord,
  OverseerGoalRecord,
  OverseerPhase,
  OverseerPlanNodeBase,
  OverseerTask,
} from "../../infra/overseer/store.types.js";
import type { GatewayRequestHandlers } from "./types.js";

function normalizeWorkStatus(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  switch (trimmed) {
    case "todo":
    case "queued":
    case "in_progress":
    case "blocked":
    case "done":
    case "cancelled":
      return trimmed;
    default:
      return undefined;
  }
}

function normalizeAssignmentStatus(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  switch (trimmed) {
    case "queued":
    case "in_progress":
    case "blocked":
    case "done":
    case "cancelled":
    case "dispatched":
    case "active":
    case "stalled":
      return trimmed;
    default:
      return undefined;
  }
}

function updateGoalRollups(goal: OverseerGoalRecord) {
  const plan = goal.plan;
  if (!plan) return;
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      if (task.subtasks.length === 0) continue;
      if (task.subtasks.every((subtask) => subtask.status === "done")) {
        task.status = "done";
      } else if (task.subtasks.some((subtask) => subtask.status === "in_progress")) {
        task.status = "in_progress";
      }
      task.updatedAt = Date.now();
    }
    if (phase.tasks.length > 0 && phase.tasks.every((task) => task.status === "done")) {
      phase.status = "done";
    } else if (phase.tasks.some((task) => task.status === "in_progress")) {
      phase.status = "in_progress";
    }
    phase.updatedAt = Date.now();
  }
  if (plan.phases.length > 0 && plan.phases.every((phase) => phase.status === "done")) {
    goal.status = "completed";
  }
  goal.updatedAt = Date.now();
}

function summarizeStatus(): OverseerStatusResult {
  const store = loadOverseerStoreFromDisk();
  const goals = Object.values(store.goals ?? {}).map((goal) => ({
    goalId: goal.goalId,
    title: goal.title,
    status: goal.status,
    priority: goal.priority,
    updatedAt: goal.updatedAt,
    tags: goal.tags ?? [],
  }));
  const stalledAssignments = Object.values(store.assignments ?? {})
    .filter((assignment) => assignment.status === "stalled")
    .map((assignment) => ({
      assignmentId: assignment.assignmentId,
      goalId: assignment.goalId,
      workNodeId: assignment.workNodeId,
      status: assignment.status,
      lastDispatchAt: assignment.lastDispatchAt,
      lastObservedActivityAt: assignment.lastObservedActivityAt,
      retryCount: assignment.retryCount,
    }));
  return { ts: Date.now(), goals, stalledAssignments };
}

function serializePlanNodeBase(node: OverseerPlanNodeBase) {
  return {
    id: node.id,
    parentId: node.parentId,
    path: node.path,
    name: node.name,
    objective: node.objective,
    expectedOutcome: node.expectedOutcome,
    acceptanceCriteria: node.acceptanceCriteria ?? [],
    definitionOfDone: node.definitionOfDone,
    dependsOn: node.dependsOn ?? [],
    blocks: node.blocks ?? [],
    suggestedAgentId: node.suggestedAgentId,
    suggestedAgentType: node.suggestedAgentType,
    requiredTools: node.requiredTools ?? [],
    estimatedEffort: node.estimatedEffort,
    riskLevel: node.riskLevel,
    status: node.status,
    blockedReason: node.blockedReason,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
  };
}

function serializeTask(task: OverseerTask) {
  return {
    ...serializePlanNodeBase(task),
    subtasks: task.subtasks.map((subtask) => ({
      ...serializePlanNodeBase(subtask),
    })),
  };
}

function serializePhase(phase: OverseerPhase) {
  return {
    ...serializePlanNodeBase(phase),
    tasks: phase.tasks.map((task) => serializeTask(task)),
  };
}

function serializeGoalForStatus(goal: OverseerGoalRecord) {
  return {
    goalId: goal.goalId,
    title: goal.title,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    status: goal.status,
    priority: goal.priority,
    tags: goal.tags ?? [],
    problemStatement: goal.problemStatement,
    successCriteria: goal.successCriteria ?? [],
    nonGoals: goal.nonGoals ?? [],
    constraints: goal.constraints,
    owner: goal.owner,
    stakeholders: goal.stakeholders,
    repoContextSnapshot: goal.repoContextSnapshot,
    assumptions: goal.assumptions,
    risks: goal.risks,
    plan: goal.plan
      ? {
          planVersion: goal.plan.planVersion,
          phases: goal.plan.phases.map((phase) => serializePhase(phase)),
        }
      : undefined,
  };
}

function buildAssignmentsFromPlan(params: {
  goal: OverseerGoalRecord;
  sessionKey: string;
  agentId: string;
  idleAfterMs: number;
  deliveryContext?: OverseerAssignmentRecord["deliveryContext"];
}): OverseerAssignmentRecord[] {
  const plan = params.goal.plan;
  if (!plan) return [];
  const assignments: OverseerAssignmentRecord[] = [];
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      for (const subtask of task.subtasks) {
        const assignmentId = `A_${crypto.randomUUID()}`;
        assignments.push({
          assignmentId,
          goalId: params.goal.goalId,
          workNodeId: subtask.id,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          deliveryContext: params.deliveryContext,
          status: "queued",
          dispatchHistory: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          idleAfterMs: params.idleAfterMs,
        });
      }
    }
  }
  return assignments;
}

export const overseerHandlers: GatewayRequestHandlers = {
  "overseer.status": ({ params, respond }) => {
    if (!validateOverseerStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid overseer.status params: ${formatValidationErrors(
            validateOverseerStatusParams.errors,
          )}`,
        ),
      );
      return;
    }
    const request = params as { includeGoals?: boolean; includeAssignments?: boolean };
    const result = summarizeStatus();
    if (request.includeGoals === false) result.goals = [];
    if (request.includeAssignments === false) result.stalledAssignments = [];
    respond(true, result, undefined);
  },
  "overseer.goal.create": async ({ params, respond }) => {
    if (!validateOverseerGoalCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid overseer.goal.create params: ${formatValidationErrors(
            validateOverseerGoalCreateParams.errors,
          )}`,
        ),
      );
      return;
    }
    const request = params as OverseerGoalCreateParams;
    const cfg = loadConfig();
    const idleAfterMs = (() => {
      try {
        return parseDurationMs(cfg.overseer?.idleAfter ?? "15m");
      } catch {
        return 15 * 60_000;
      }
    })();
    const resolvedAgent = request.fromSession
      ? resolveAgentIdFromSessionKey(request.fromSession)
      : resolveDefaultAgentId(cfg);
    const agentId = normalizeAgentId(resolvedAgent);
    const sessionKey = request.fromSession?.trim()
      ? request.fromSession.trim()
      : resolveAgentMainSessionKey({ cfg, agentId });
    const originDeliveryContext = request.fromSession?.trim()
      ? loadSessionEntry(sessionKey).entry?.deliveryContext
      : undefined;
    const goalId = `goal_${crypto.randomUUID()}`;
    const goal: OverseerGoalRecord = {
      goalId,
      title: request.title.trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "active",
      priority:
        request.priority === "low" || request.priority === "high" || request.priority === "urgent"
          ? request.priority
          : "normal",
      tags: Array.isArray(request.tags) ? request.tags.filter(Boolean) : [],
      problemStatement: request.problemStatement.trim(),
      successCriteria: Array.isArray(request.successCriteria) ? request.successCriteria : [],
      nonGoals: Array.isArray(request.nonGoals) ? request.nonGoals : [],
      constraints: Array.isArray(request.constraints) ? request.constraints : [],
      owner: request.owner?.trim() || undefined,
      repoContextSnapshot: request.repoContextSnapshot,
      origin: {
        sourceSessionKey: sessionKey,
        originDeliveryContext,
      },
    };
    let planGenerated = false;
    let assignments: OverseerAssignmentRecord[] = [];
    const shouldGenerate = request.generatePlan !== false && Boolean(cfg.overseer?.planner?.model);
    if (shouldGenerate) {
      const plannerInputs = {
        title: goal.title,
        problemStatement: goal.problemStatement,
        successCriteria: goal.successCriteria ?? [],
        constraints: goal.constraints ?? [],
        repoContextSnapshot: goal.repoContextSnapshot ?? "",
      };
      const planResult = await generateOverseerPlan({
        goalTitle: goal.title,
        problemStatement: goal.problemStatement,
        successCriteria: goal.successCriteria ?? [],
        constraints: goal.constraints ?? [],
        repoContextSnapshot: goal.repoContextSnapshot,
        agentId,
      });
      goal.plan = planResult.plan;
      goal.planner = {
        modelRef: cfg.overseer?.planner?.model,
        promptTemplateId: planResult.promptTemplateId,
        promptTemplateHash: planResult.promptTemplateHash,
      };
      goal.plannerInputs = JSON.stringify(plannerInputs);
      goal.rawPlannerOutputJson = planResult.rawJson;
      goal.validationErrors = planResult.validationErrors;
      goal.planRevisionHistory = [{ ts: Date.now(), summary: "initial plan" }];
      planGenerated = true;
      const safeIdleAfterMs =
        Number.isFinite(idleAfterMs) && idleAfterMs > 0 ? idleAfterMs : 15 * 60_000;
      assignments = buildAssignmentsFromPlan({
        goal,
        sessionKey,
        agentId,
        idleAfterMs: safeIdleAfterMs,
        deliveryContext: originDeliveryContext,
      });
    }

    await updateOverseerStore(async (store) => {
      store.goals[goal.goalId] = goal;
      for (const assignment of assignments) {
        store.assignments[assignment.assignmentId] = assignment;
      }
      appendOverseerEvent(store, {
        ts: Date.now(),
        type: "goal.created",
        goalId: goal.goalId,
      });
      if (planGenerated) {
        appendOverseerEvent(store, {
          ts: Date.now(),
          type: "plan.generated",
          goalId: goal.goalId,
        });
      }
      return { store, result: true };
    });
    const result: OverseerGoalCreateResult = { goalId, planGenerated };
    respond(true, result, undefined);
  },
  "overseer.goal.status": ({ params, respond }) => {
    if (!validateOverseerGoalStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid overseer.goal.status params: ${formatValidationErrors(
            validateOverseerGoalStatusParams.errors,
          )}`,
        ),
      );
      return;
    }
    const request = params as { goalId: string };
    const store = loadOverseerStoreFromDisk();
    const goal = store.goals?.[request.goalId];
    const assignments = Object.values(store.assignments ?? {}).filter(
      (assignment) => assignment.goalId === request.goalId,
    );
    const crystallizations = Object.values(store.crystallizations ?? {}).filter(
      (crystallization) => crystallization.goalId === request.goalId,
    );
    const events = (store.events ?? [])
      .filter((event) => event.goalId === request.goalId)
      .slice(-200);
    respond(
      true,
      {
        ts: Date.now(),
        goal: goal ? serializeGoalForStatus(goal) : undefined,
        assignments,
        crystallizations,
        events,
      },
      undefined,
    );
  },
  "overseer.goal.pause": async ({ params, respond }) => {
    if (!validateOverseerGoalStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid overseer.goal.pause params: ${formatValidationErrors(
            validateOverseerGoalStatusParams.errors,
          )}`,
        ),
      );
      return;
    }
    const request = params as { goalId: string };
    await updateOverseerStore(async (store) => {
      const goal = store.goals[request.goalId];
      if (goal) {
        goal.status = "paused";
        goal.updatedAt = Date.now();
        appendOverseerEvent(store, {
          ts: Date.now(),
          type: "goal.paused",
          goalId: goal.goalId,
        });
      }
      return { store, result: true };
    });
    respond(true, { ok: true }, undefined);
  },
  "overseer.goal.resume": async ({ params, respond }) => {
    if (!validateOverseerGoalStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid overseer.goal.resume params: ${formatValidationErrors(
            validateOverseerGoalStatusParams.errors,
          )}`,
        ),
      );
      return;
    }
    const request = params as { goalId: string };
    await updateOverseerStore(async (store) => {
      const goal = store.goals[request.goalId];
      if (goal) {
        goal.status = "active";
        goal.updatedAt = Date.now();
        appendOverseerEvent(store, {
          ts: Date.now(),
          type: "goal.resumed",
          goalId: goal.goalId,
        });
      }
      return { store, result: true };
    });
    respond(true, { ok: true }, undefined);
  },
  "overseer.goal.update": async ({ params, respond }) => {
    if (!validateOverseerGoalUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid overseer.goal.update params: ${formatValidationErrors(
            validateOverseerGoalUpdateParams.errors,
          )}`,
        ),
      );
      return;
    }
    const request = params as OverseerGoalUpdateParams;
    await updateOverseerStore(async (store) => {
      const goal = store.goals[request.goalId];
      if (!goal) return { store, result: true };
      if (typeof request.title === "string") {
        goal.title = request.title.trim();
      }
      if (typeof request.problemStatement === "string") {
        goal.problemStatement = request.problemStatement.trim();
      }
      if (Array.isArray(request.successCriteria)) {
        goal.successCriteria = request.successCriteria.map((item) => item.trim()).filter(Boolean);
      }
      if (Array.isArray(request.constraints)) {
        goal.constraints = request.constraints.map((item) => item.trim()).filter(Boolean);
      }
      goal.updatedAt = Date.now();
      appendOverseerEvent(store, {
        ts: Date.now(),
        type: "goal.updated",
        goalId: goal.goalId,
      });
      return { store, result: true };
    });
    respond(true, { ok: true }, undefined);
  },
  "overseer.goal.cancel": async ({ params, respond }) => {
    if (!validateOverseerGoalStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid overseer.goal.cancel params: ${formatValidationErrors(
            validateOverseerGoalStatusParams.errors,
          )}`,
        ),
      );
      return;
    }
    const request = params as { goalId: string };
    const now = Date.now();
    await updateOverseerStore(async (store) => {
      const goal = store.goals[request.goalId];
      if (!goal) return { store, result: true };

      goal.status = "cancelled";
      goal.updatedAt = now;

      if (goal.plan) {
        for (const phase of goal.plan.phases) {
          const nodes = [phase, ...phase.tasks, ...phase.tasks.flatMap((task) => task.subtasks)];
          for (const node of nodes) {
            if (node.status === "done") continue;
            node.status = "cancelled";
            node.updatedAt = now;
            node.endedAt = node.endedAt ?? now;
          }
        }
      }

      for (const assignment of Object.values(store.assignments ?? {})) {
        if (assignment.goalId !== goal.goalId) continue;
        if (assignment.status === "done") continue;
        assignment.status = "cancelled";
        assignment.updatedAt = now;
      }

      appendOverseerEvent(store, {
        ts: now,
        type: "goal.cancelled",
        goalId: goal.goalId,
      });

      return { store, result: true };
    });
    respond(true, { ok: true }, undefined);
  },
  "overseer.work.update": async ({ params, respond }) => {
    if (!validateOverseerWorkUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid overseer.work.update params: ${formatValidationErrors(
            validateOverseerWorkUpdateParams.errors,
          )}`,
        ),
      );
      return;
    }
    const request = params as OverseerWorkUpdateParams;
    const normalizedStatus = normalizeWorkStatus(request.status);
    if (request.status && !normalizedStatus) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid status value"));
      return;
    }
    const assignmentStatus = normalizeAssignmentStatus(request.status);
    await updateOverseerStore(async (store) => {
      const goal = store.goals[request.goalId];
      if (!goal || !goal.plan) return { store, result: true };
      const workNodeId = request.workNodeId;
      for (const phase of goal.plan.phases) {
        const nodes = [phase, ...phase.tasks, ...phase.tasks.flatMap((task) => task.subtasks)];
        for (const node of nodes) {
          if (node.id !== workNodeId) continue;
          if (normalizedStatus) {
            node.status = normalizedStatus;
            node.updatedAt = Date.now();
            if (normalizedStatus === "done") {
              node.endedAt = Date.now();
            }
          }
          if (request.blockedReason) {
            node.blockedReason = request.blockedReason;
          }
        }
      }
      for (const assignment of Object.values(store.assignments ?? {})) {
        if (assignment.goalId !== goal.goalId) continue;
        if (assignment.workNodeId !== workNodeId) continue;
        if (assignmentStatus) assignment.status = assignmentStatus as any;
        if (request.blockedReason) assignment.blockedReason = request.blockedReason;
        assignment.updatedAt = Date.now();
      }
      updateGoalRollups(goal);
      if (request.summary || request.evidence) {
        const crystallizationId = `C_${crypto.randomUUID()}`;
        store.crystallizations[crystallizationId] = {
          crystallizationId,
          goalId: goal.goalId,
          workNodeId,
          summary: request.summary,
          evidence: request.evidence,
          createdAt: Date.now(),
        };
        appendOverseerEvent(store, {
          ts: Date.now(),
          type: "crystallization.created",
          goalId: goal.goalId,
          workNodeId,
          data: { crystallizationId },
        });
      }
      appendOverseerEvent(store, {
        ts: Date.now(),
        type: "work.updated",
        goalId: goal.goalId,
        workNodeId,
      });
      return { store, result: true };
    });
    respond(true, { ok: true }, undefined);
  },
  "overseer.tick": async ({ params, respond, context }) => {
    if (!validateOverseerTickParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid overseer.tick params: ${formatValidationErrors(validateOverseerTickParams.errors)}`,
        ),
      );
      return;
    }
    const request = params as OverseerTickParams;
    const res = await context.overseerRunner?.tickNow({ reason: request.reason });
    respond(true, res ?? { ok: false, didWork: false }, undefined);
  },

  // Simulator methods
  "overseer.simulator.load": async ({ respond }) => {
    // Load simulator state from store metadata
    const store = loadOverseerStoreFromDisk();
    const simulatorData = (store as Record<string, unknown>).simulatorState as
      | {
          rules?: unknown[];
          scenarios?: unknown[];
        }
      | undefined;
    respond(true, simulatorData ?? { rules: [], scenarios: [] }, undefined);
  },

  "overseer.simulator.save": async ({ params, respond }) => {
    const request = params as { rules?: unknown[]; scenarios?: unknown[] };
    await updateOverseerStore(async (store) => {
      (store as Record<string, unknown>).simulatorState = {
        rules: request.rules ?? [],
        scenarios: request.scenarios ?? [],
      };
      return { store, result: true };
    });
    respond(true, { ok: true }, undefined);
  },

  "overseer.simulator.injectEvent": async ({ params, respond, context }) => {
    const request = params as {
      type: string;
      goalId?: string;
      assignmentId?: string;
      sessionKey?: string;
      data?: Record<string, unknown>;
    };

    const now = Date.now();

    await updateOverseerStore(async (store) => {
      // Log the simulated event
      appendOverseerEvent(store, {
        ts: now,
        type: `simulator.${request.type}`,
        goalId: request.goalId,
        assignmentId: request.assignmentId,
        data: { source: "simulator", ...request.data },
      });

      // Handle specific event types
      if (request.type === "assignment_stalled" && request.assignmentId) {
        const assignment = store.assignments[request.assignmentId];
        if (assignment) {
          assignment.status = "stalled";
          assignment.updatedAt = now;
        }
      } else if (request.type === "assignment_active" && request.assignmentId) {
        const assignment = store.assignments[request.assignmentId];
        if (assignment) {
          assignment.status = "active";
          assignment.lastObservedActivityAt = now;
          assignment.updatedAt = now;
        }
      } else if (request.type === "goal_completed" && request.goalId) {
        const goal = store.goals[request.goalId];
        if (goal) {
          goal.status = "completed";
          goal.updatedAt = now;
        }
      }

      return { store, result: true };
    });

    // Trigger a tick if requested
    if (request.type === "tick_triggered") {
      const res = await context.overseerRunner?.tickNow({ reason: "simulator" });
      respond(true, { ok: true, tickResult: res }, undefined);
      return;
    }

    respond(true, { ok: true }, undefined);
  },
};
