import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { emit } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import { acquireTaskLock } from "../../infra/task-lock.js";
import { disableAgentManagedMode, enableAgentManagedMode } from "../../infra/task-tracker.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId, listAgentIds } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  type TaskFile,
  type TaskPriority,
  type EstimatedEffort,
  generateTaskId,
  generateWorkSessionId,
  readTask,
  writeTask,
  findActiveTask,
  findBlockedTasks,
  findAllBacklogTasks,
  findSimilarTask,
  findPickableBacklogTask,
  checkDependenciesMet,
  updateCurrentTaskPointer,
} from "./task-file-io.js";
const TaskApproveSchema = Type.Object({
  task_id: Type.String(),
});

const TaskBlockSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
  reason: Type.String(),
  unblock_by: Type.Array(Type.String()),
  unblock_action: Type.Optional(Type.String()),
});

const TaskResumeSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
});

const TaskBacklogAddSchema = Type.Object({
  description: Type.String(),
  context: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String()),
  estimated_effort: Type.Optional(Type.String()),
  start_date: Type.Optional(Type.String()),
  due_date: Type.Optional(Type.String()),
  depends_on: Type.Optional(Type.Array(Type.String())),
  assignee: Type.Optional(Type.String()),
  milestone_id: Type.Optional(Type.String()),
  milestone_item_id: Type.Optional(Type.String()),
  harness_project_slug: Type.Optional(Type.String()),
  harness_item_id: Type.Optional(Type.String()),
});

const TaskPickBacklogSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
});

export function createTaskApproveTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  return {
    label: "Task Approve",
    name: "task_approve",
    description:
      "Approve a task that is waiting for approval. Transitions task from pending_approval to in_progress status.",
    parameters: TaskApproveSchema,
    execute: async (_toolCallId, params) => {
      const taskId = readStringParam(params, "task_id", { required: true });

      const task = await readTask(workspaceDir, taskId);
      if (!task) {
        return jsonResult({
          success: false,
          error: `Task not found: ${taskId}`,
        });
      }

      if (task.status !== "pending_approval") {
        return jsonResult({
          success: false,
          error: `Task ${taskId} is not pending approval. Current status: ${task.status}`,
        });
      }

      const now = new Date().toISOString();
      task.status = "in_progress";
      task.lastActivity = now;
      task.progress.push("Task approved and started");

      await writeTask(workspaceDir, task);
      emit({
        type: EVENT_TYPES.TASK_APPROVED,
        agentId,
        ts: Date.now(),
        data: { taskId: task.id, workSessionId: task.workSessionId },
      });
      await updateCurrentTaskPointer(workspaceDir, task.id);

      enableAgentManagedMode(agentId);

      return jsonResult({
        success: true,
        taskId: task.id,
        approved: true,
        startedAt: now,
        workSessionId: task.workSessionId,
      });
    },
  };
}

export function createTaskBlockTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  return {
    label: "Task Block",
    name: "task_block",
    description:
      "Block a task that cannot proceed without another agent's help. Specify unblock_by with agent IDs who can help unblock. The system will automatically send unblock requests to those agents (up to 3 times).",
    parameters: TaskBlockSchema,
    execute: async (_toolCallId, params) => {
      const taskIdParam = readStringParam(params, "task_id");
      const reason = readStringParam(params, "reason", { required: true });
      const unblockedAction = readStringParam(params, "unblock_action");

      const rawUnblockBy = (params as Record<string, unknown>).unblock_by;
      const unblockedBy = Array.isArray(rawUnblockBy)
        ? rawUnblockBy.filter((s): s is string => typeof s === "string")
        : [];

      if (unblockedBy.length === 0) {
        return jsonResult({
          success: false,
          error: "unblock_by must be a non-empty array of agent IDs",
        });
      }

      // Validate agent IDs
      const validAgentIds = listAgentIds(cfg);
      const currentAgentId = agentId;
      const invalidIds: string[] = [];
      const selfReferences: string[] = [];

      for (const agentIdToCheck of unblockedBy) {
        if (!validAgentIds.includes(agentIdToCheck)) {
          invalidIds.push(agentIdToCheck);
        }
        if (agentIdToCheck === currentAgentId) {
          selfReferences.push(agentIdToCheck);
        }
      }

      if (invalidIds.length > 0) {
        return jsonResult({
          success: false,
          error: `Invalid agent ID(s) in unblock_by: ${invalidIds.join(", ")}. Valid agents: ${validAgentIds.join(", ")}`,
        });
      }

      if (selfReferences.length > 0) {
        return jsonResult({
          success: false,
          error: `Agent cannot unblock itself. Remove "${selfReferences.join(", ")}" from unblock_by.`,
        });
      }

      // Deduplicate agent IDs
      const uniqueUnblockedBy = [...new Set(unblockedBy)];

      let task: TaskFile | null = null;

      if (taskIdParam) {
        task = await readTask(workspaceDir, taskIdParam);
        if (!task) {
          return jsonResult({
            success: false,
            error: `Task not found: ${taskIdParam}`,
          });
        }
      } else {
        task = await findActiveTask(workspaceDir);
        if (!task) {
          return jsonResult({
            success: false,
            error: "No active task to block. Use task_start first or specify task_id.",
          });
        }
      }

      const lock = await acquireTaskLock(workspaceDir, task.id);
      if (!lock) {
        return jsonResult({
          success: false,
          error: `Task ${task.id} is locked by another operation`,
        });
      }

      try {
        const now = new Date().toISOString();
        task.status = "blocked";
        task.lastActivity = now;
        task.blockedReason = reason;
        task.unblockedBy = uniqueUnblockedBy;
        task.unblockedAction = unblockedAction;
        task.unblockRequestCount = 0;
        task.lastUnblockerIndex = undefined;
        task.lastUnblockRequestAt = undefined;
        task.escalationState = "none";
        task.progress.push(`[BLOCKED] ${reason}`);

        await writeTask(workspaceDir, task);
        emit({
          type: EVENT_TYPES.TASK_BLOCKED,
          agentId,
          ts: Date.now(),
          data: {
            taskId: task.id,
            reason,
            unblockedBy: uniqueUnblockedBy,
            workSessionId: task.workSessionId,
          },
        });
        await updateCurrentTaskPointer(workspaceDir, task.id);

        disableAgentManagedMode(agentId);

        return jsonResult({
          success: true,
          taskId: task.id,
          status: "blocked",
          blockedReason: reason,
          unblockedBy,
          unblockedAction: unblockedAction || null,
          unblockRequestCount: 0,
          workSessionId: task.workSessionId,
          message: `Task blocked. Unblock requests will be sent to: ${unblockedBy.join(", ")}`,
        });
      } finally {
        await lock.release();
      }
    },
  };
}

export function createTaskResumeTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  return {
    label: "Task Resume",
    name: "task_resume",
    description:
      "Resume a blocked task. Transitions task from blocked to in_progress status. If task_id is omitted, resumes the most recently blocked task.",
    parameters: TaskResumeSchema,
    execute: async (_toolCallId, params) => {
      const taskIdParam = readStringParam(params, "task_id");

      let task: TaskFile | null = null;

      if (taskIdParam) {
        task = await readTask(workspaceDir, taskIdParam);
        if (!task) {
          return jsonResult({
            success: false,
            error: `Task not found: ${taskIdParam}`,
          });
        }
      } else {
        const blockedTasks = await findBlockedTasks(workspaceDir);
        task = blockedTasks[0] || null;
        if (!task) {
          return jsonResult({
            success: false,
            error: "No blocked task to resume.",
          });
        }
      }

      if (task.status !== "blocked") {
        return jsonResult({
          success: false,
          error: `Task ${task.id} is not blocked. Current status: ${task.status}`,
        });
      }

      const lock = await acquireTaskLock(workspaceDir, task.id);
      if (!lock) {
        return jsonResult({
          success: false,
          error: `Task ${task.id} is locked by another operation`,
        });
      }

      try {
        const now = new Date().toISOString();
        task.status = "in_progress";
        task.lastActivity = now;
        task.progress.push("Task resumed from blocked state");

        task.blockedReason = undefined;
        task.unblockedBy = undefined;
        task.unblockedAction = undefined;
        task.unblockRequestCount = undefined;
        task.lastUnblockerIndex = undefined;
        task.escalationState = undefined;

        await writeTask(workspaceDir, task);
        emit({
          type: EVENT_TYPES.TASK_RESUMED,
          agentId,
          ts: Date.now(),
          data: { taskId: task.id, workSessionId: task.workSessionId },
        });
        await updateCurrentTaskPointer(workspaceDir, task.id);

        enableAgentManagedMode(agentId);

        return jsonResult({
          success: true,
          taskId: task.id,
          resumed: true,
          resumedAt: now,
          workSessionId: task.workSessionId,
        });
      } finally {
        await lock.release();
      }
    },
  };
}

export function createTaskBacklogAddTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  const currentAgentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  return {
    label: "Task Backlog Add",
    name: "task_backlog_add",
    description:
      "Add a task to the backlog. Backlog tasks are picked up automatically when no active task exists. Use assignee to add to another agent's backlog. Priority defaults to 'low' for cross-agent requests.",
    parameters: TaskBacklogAddSchema,
    execute: async (_toolCallId, params) => {
      const description = readStringParam(params, "description", { required: true });
      const context = readStringParam(params, "context");
      const priorityRaw = readStringParam(params, "priority") || "medium";
      const estimatedEffortRaw = readStringParam(params, "estimated_effort");
      const startDateRaw = readStringParam(params, "start_date");
      const dueDateRaw = readStringParam(params, "due_date");
      const assigneeRaw = readStringParam(params, "assignee");

      const rawDependsOn = (params as Record<string, unknown>).depends_on;
      const dependsOn = Array.isArray(rawDependsOn)
        ? rawDependsOn.filter((s): s is string => typeof s === "string")
        : undefined;

      const targetAgentId = assigneeRaw || currentAgentId;
      const isCrossAgent = targetAgentId !== currentAgentId;

      if (isCrossAgent) {
        const validAgentIds = listAgentIds(cfg);
        if (!validAgentIds.includes(targetAgentId)) {
          return jsonResult({
            success: false,
            error: `Invalid assignee: ${targetAgentId}. Valid agents: ${validAgentIds.join(", ")}`,
          });
        }
      }

      const priority: TaskPriority = ["low", "medium", "high", "urgent"].includes(priorityRaw)
        ? (priorityRaw as TaskPriority)
        : "medium";

      const estimatedEffort: EstimatedEffort | undefined =
        estimatedEffortRaw && ["small", "medium", "large"].includes(estimatedEffortRaw)
          ? (estimatedEffortRaw as EstimatedEffort)
          : undefined;

      const workspaceDir = resolveAgentWorkspaceDir(cfg, targetAgentId);
      const now = new Date().toISOString();
      const taskId = generateTaskId();
      const workSessionId = generateWorkSessionId();

      const newTask: TaskFile = {
        id: taskId,
        status: "backlog",
        priority,
        description,
        context,
        source: isCrossAgent ? `request:${currentAgentId}` : "self",
        created: now,
        lastActivity: now,
        workSessionId,
        progress: [`Added to backlog${isCrossAgent ? ` by ${currentAgentId}` : ""}`],
        createdBy: currentAgentId,
        assignee: targetAgentId,
        dependsOn: dependsOn && dependsOn.length > 0 ? dependsOn : undefined,
        estimatedEffort,
        startDate: startDateRaw,
        dueDate: dueDateRaw,
        milestoneId: readStringParam(params, "milestone_id"),
        milestoneItemId: readStringParam(params, "milestone_item_id"),
        harnessProjectSlug: readStringParam(params, "harness_project_slug"),
        harnessItemId: readStringParam(params, "harness_item_id"),
      };

      // Duplicate detection: reject if a similar backlog task already exists
      const existingBacklog = await findAllBacklogTasks(workspaceDir);
      const duplicate = findSimilarTask(existingBacklog, description);
      if (duplicate) {
        return jsonResult({
          success: false,
          error: "duplicate_task",
          existingTaskId: duplicate.id,
          existingDescription: duplicate.description,
          message: `Similar backlog task already exists: ${duplicate.id}`,
        });
      }

      await writeTask(workspaceDir, newTask);
      emit({
        type: EVENT_TYPES.TASK_BACKLOG_ADDED,
        agentId: currentAgentId,
        ts: Date.now(),
        data: { taskId, assignee: targetAgentId, isCrossAgent, workSessionId },
      });

      const allBacklog = await findAllBacklogTasks(workspaceDir);

      return jsonResult({
        success: true,
        taskId,
        status: "backlog",
        assignee: targetAgentId,
        isCrossAgent,
        priority,
        workSessionId: newTask.workSessionId,
        estimatedEffort: estimatedEffort || null,
        startDate: startDateRaw || null,
        dueDate: dueDateRaw || null,
        dependsOn: dependsOn || [],
        totalBacklogItems: allBacklog.length,
      });
    },
  };
}

export function createTaskPickBacklogTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  return {
    label: "Task Pick Backlog",
    name: "task_pick_backlog",
    description:
      "Pick a task from the backlog and start working on it. If task_id is omitted, picks the highest priority task that meets all conditions (dependencies met, start_date passed).",
    parameters: TaskPickBacklogSchema,
    execute: async (_toolCallId, params) => {
      const activeTask = await findActiveTask(workspaceDir);
      if (activeTask) {
        return jsonResult({
          success: false,
          error: `Already have an active task: ${activeTask.id}. Complete or block it first.`,
          currentTaskId: activeTask.id,
        });
      }

      const taskIdParam = readStringParam(params, "task_id");
      let task: TaskFile | null = null;

      if (taskIdParam) {
        task = await readTask(workspaceDir, taskIdParam);
        if (!task) {
          return jsonResult({
            success: false,
            error: `Task not found: ${taskIdParam}`,
          });
        }
        if (task.status !== "backlog") {
          return jsonResult({
            success: false,
            error: `Task ${taskIdParam} is not in backlog. Status: ${task.status}`,
          });
        }

        const now = new Date();
        if (task.startDate && new Date(task.startDate) > now) {
          return jsonResult({
            success: false,
            error: `Task ${taskIdParam} cannot start until ${task.startDate}`,
          });
        }

        const { met, unmetDeps } = await checkDependenciesMet(workspaceDir, task);
        if (!met) {
          return jsonResult({
            success: false,
            error: `Task ${taskIdParam} has unmet dependencies: ${unmetDeps.join(", ")}`,
            unmetDependencies: unmetDeps,
          });
        }
      } else {
        task = await findPickableBacklogTask(workspaceDir);
        if (!task) {
          const allBacklog = await findAllBacklogTasks(workspaceDir);
          return jsonResult({
            success: false,
            error:
              allBacklog.length > 0
                ? "No pickable backlog task (all have unmet dependencies or future start dates)"
                : "No backlog tasks available",
            totalBacklogItems: allBacklog.length,
          });
        }
      }

      const lock = await acquireTaskLock(workspaceDir, task.id);
      if (!lock) {
        return jsonResult({
          success: false,
          error: `Task ${task.id} is locked by another operation`,
        });
      }

      try {
        const freshTask = await readTask(workspaceDir, task.id);
        if (!freshTask || freshTask.status !== "backlog") {
          return jsonResult({ success: false, error: `Task ${task.id} is no longer in backlog` });
        }

        const now = new Date().toISOString();
        freshTask.status = "in_progress";
        freshTask.lastActivity = now;
        freshTask.progress.push("Picked from backlog and started");

        await writeTask(workspaceDir, freshTask);
        emit({
          type: EVENT_TYPES.TASK_BACKLOG_PICKED,
          agentId,
          ts: Date.now(),
          data: { taskId: freshTask.id, workSessionId: freshTask.workSessionId },
        });
        await updateCurrentTaskPointer(workspaceDir, freshTask.id);

        enableAgentManagedMode(agentId);

        const remainingBacklog = await findAllBacklogTasks(workspaceDir);

        return jsonResult({
          success: true,
          taskId: freshTask.id,
          description: freshTask.description,
          priority: freshTask.priority,
          pickedFromBacklog: true,
          workSessionId: freshTask.workSessionId,
          startedAt: now,
          remainingBacklogItems: remainingBacklog.length,
        });
      } finally {
        await lock.release();
      }
    },
  };
}
