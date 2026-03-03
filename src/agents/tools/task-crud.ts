import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { emit } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import { retryAsync } from "../../infra/retry.js";
import { acquireTaskLock } from "../../infra/task-lock.js";
import { disableAgentManagedMode, enableAgentManagedMode } from "../../infra/task-tracker.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId, listAgentIds } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  type TaskFile,
  type TaskPriority,
  type TaskStatus,
  type TaskStepStatus,
  generateTaskId,
  generateWorkSessionId,
  readTask,
  writeTask,
  deleteTask,
  listTasks,
  findActiveTask,
  findSimilarTask,
  appendToHistory,
  formatTaskHistoryEntry,
  updateCurrentTaskPointer,
  hasActiveTasks,
} from "./task-file-io.js";
import { checkStopGuard } from "./task-stop-guard.js";

const log = createSubsystemLogger("task-tool");
const TaskStartSchema = Type.Object({
  description: Type.String(),
  context: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String()),
  requires_approval: Type.Optional(Type.Boolean()),
  simple: Type.Optional(Type.Boolean()),
  steps: Type.Optional(
    Type.Array(
      Type.Object({
        content: Type.String(),
        status: Type.Optional(Type.String()),
      }),
    ),
  ),
});

const TaskUpdateSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
  progress: Type.Optional(Type.String()),
  action: Type.Optional(Type.String()),
  step_content: Type.Optional(Type.String()),
  step_id: Type.Optional(Type.String()),
  steps_order: Type.Optional(Type.Array(Type.String())),
  steps: Type.Optional(
    Type.Array(
      Type.Object({
        content: Type.String(),
        status: Type.Optional(Type.String()),
      }),
    ),
  ),
});

const TaskCompleteSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  force_complete: Type.Optional(Type.String()),
});

const TaskStatusSchema = Type.Object({
  task_id: Type.Optional(Type.String()),
});

const TaskListSchema = Type.Object({
  status: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()),
});

const TaskCancelSchema = Type.Object({
  task_id: Type.String(),
  reason: Type.Optional(Type.String()),
});

export function createTaskStartTool(options: {
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
    label: "Task Start",
    name: "task_start",
    description:
      "Start a new task. Creates a task file in tasks/ directory. Multiple tasks can exist simultaneously. If requires_approval is true, task starts in pending_approval status and needs task_approve before work begins. Returns the task_id for future reference.",
    parameters: TaskStartSchema,
    execute: async (_toolCallId, params) => {
      const description = readStringParam(params, "description", { required: true });
      const context = readStringParam(params, "context");
      const priorityRaw = readStringParam(params, "priority") || "medium";
      const priority = ["low", "medium", "high", "urgent"].includes(priorityRaw)
        ? (priorityRaw as TaskPriority)
        : "medium";
      const requiresApproval = (params as Record<string, unknown>).requires_approval === true;
      const simple = (params as Record<string, unknown>).simple === true;
      const rawSteps = (params as Record<string, unknown>).steps;
      const stepsInput = Array.isArray(rawSteps)
        ? (rawSteps as Array<{ content: string; status?: string }>)
        : undefined;

      // Duplicate detection: reject if a similar task already exists
      const activeTasks = await listTasks(workspaceDir, "in_progress");
      const pendingTasks = await listTasks(workspaceDir, "pending_approval");
      const duplicate = findSimilarTask([...activeTasks, ...pendingTasks], description);
      if (duplicate) {
        return jsonResult({
          success: false,
          error: "duplicate_task",
          existingTaskId: duplicate.id,
          existingDescription: duplicate.description,
          message: `Similar task already exists: ${duplicate.id}`,
        });
      }

      const now = new Date().toISOString();
      const taskId = generateTaskId();

      const initialStatus: TaskStatus = requiresApproval ? "pending_approval" : "in_progress";
      const initialProgress = requiresApproval
        ? "Task created - awaiting approval"
        : "Task started";
      const workSessionId = generateWorkSessionId();

      const newTask: TaskFile = {
        id: taskId,
        status: initialStatus,
        priority,
        description,
        context,
        source: "user",
        created: now,
        lastActivity: now,
        workSessionId,
        createdBySessionKey: options.agentSessionKey,
        progress: [initialProgress],
        simple: simple || undefined,
        steps: stepsInput
          ? stepsInput.map((s, i) => ({
              id: `s${i + 1}`,
              content: s.content,
              status: (i === 0 && !requiresApproval
                ? "in_progress"
                : s.status || "pending") as TaskStepStatus,
              order: i + 1,
            }))
          : undefined,
      };

      await writeTask(workspaceDir, newTask);
      emit({
        type: EVENT_TYPES.TASK_STARTED,
        agentId,
        ts: Date.now(),
        data: { taskId, priority, requiresApproval, workSessionId },
      });
      await updateCurrentTaskPointer(workspaceDir, taskId);

      if (!requiresApproval) {
        enableAgentManagedMode(agentId);
      }

      const allTasks = await listTasks(workspaceDir);

      return jsonResult({
        success: true,
        taskId,
        status: initialStatus,
        requiresApproval,
        started: requiresApproval ? null : now,
        createdAt: now,
        priority,
        workSessionId,
        totalActiveTasks: allTasks.length,
        simple: simple || undefined,
        stepsCount: stepsInput?.length,
      });
    },
  };
}

export function createTaskUpdateTool(options: {
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
    label: "Task Update",
    name: "task_update",
    description:
      "Update a task's progress or manage steps. If task_id is omitted, updates the most recent in_progress task. Use 'progress' for free-form logs. Use 'action' for step management: set_steps, add_step, complete_step, start_step, skip_step, reorder_steps.",
    parameters: TaskUpdateSchema,
    execute: async (_toolCallId, params) => {
      const taskIdParam = readStringParam(params, "task_id");
      const progress = readStringParam(params, "progress");
      const action = readStringParam(params, "action");
      const stepContent = readStringParam(params, "step_content");
      const stepId = readStringParam(params, "step_id");
      const rawStepsOrder = (params as Record<string, unknown>).steps_order;
      const stepsOrder = Array.isArray(rawStepsOrder)
        ? rawStepsOrder.filter((s): s is string => typeof s === "string")
        : undefined;
      const rawSteps = (params as Record<string, unknown>).steps;
      const stepsInput = Array.isArray(rawSteps)
        ? (rawSteps as Array<{ content: string; status?: string }>)
        : undefined;

      if (!progress && !action) {
        return jsonResult({
          success: false,
          error: "Either progress or action is required",
        });
      }

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
            error: "No active task. Use task_start first or specify task_id.",
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
        if (!freshTask) {
          return jsonResult({
            success: false,
            error: `Task ${task.id} was deleted during lock acquisition`,
          });
        }

        const now = new Date().toISOString();
        freshTask.lastActivity = now;

        if (progress) {
          freshTask.progress.push(progress);
        }

        if (action) {
          if (!freshTask.steps) {
            freshTask.steps = [];
          }

          switch (action) {
            case "set_steps": {
              if (!stepsInput || stepsInput.length === 0) {
                return jsonResult({
                  success: false,
                  error: "set_steps requires a non-empty steps array",
                });
              }
              freshTask.steps = stepsInput.map((s, i) => ({
                id: `s${i + 1}`,
                content: s.content,
                status: (s.status === "done" || s.status === "in_progress" || s.status === "skipped"
                  ? s.status
                  : "pending") as TaskStepStatus,
                order: i + 1,
              }));
              const firstPending = freshTask.steps.find((s) => s.status === "pending");
              if (firstPending) {
                firstPending.status = "in_progress";
              }
              freshTask.progress.push(`Steps set: ${freshTask.steps.length} steps defined`);
              break;
            }
            case "add_step": {
              if (!stepContent) {
                return jsonResult({ success: false, error: "add_step requires step_content" });
              }
              const existingNums = freshTask.steps.map((s) => {
                const m = s.id.match(/^s(\d+)$/);
                return m ? parseInt(m[1], 10) : 0;
              });
              const maxNum = existingNums.length > 0 ? Math.max(...existingNums) : 0;
              const nextId = `s${maxNum + 1}`;
              const nextOrder =
                freshTask.steps.length > 0
                  ? Math.max(...freshTask.steps.map((s) => s.order)) + 1
                  : 1;
              freshTask.steps.push({
                id: nextId,
                content: stepContent,
                status: "pending",
                order: nextOrder,
              });
              freshTask.progress.push(`Step added: (${nextId}) ${stepContent}`);
              break;
            }
            case "complete_step": {
              if (!stepId) {
                return jsonResult({ success: false, error: "complete_step requires step_id" });
              }
              const step = freshTask.steps.find((s) => s.id === stepId);
              if (!step) {
                return jsonResult({ success: false, error: `Step not found: ${stepId}` });
              }
              step.status = "done";
              freshTask.progress.push(`[${stepId}] ${step.content} — completed`);
              const sortedSteps = [...freshTask.steps].toSorted((a, b) => a.order - b.order);
              const nextPending = sortedSteps.find((s) => s.status === "pending");
              if (nextPending) {
                nextPending.status = "in_progress";
              }
              break;
            }
            case "start_step": {
              if (!stepId) {
                return jsonResult({ success: false, error: "start_step requires step_id" });
              }
              const targetStep = freshTask.steps.find((s) => s.id === stepId);
              if (!targetStep) {
                return jsonResult({ success: false, error: `Step not found: ${stepId}` });
              }
              for (const s of freshTask.steps) {
                if (s.status === "in_progress") {
                  s.status = "pending";
                }
              }
              targetStep.status = "in_progress";
              freshTask.progress.push(`[${stepId}] ${targetStep.content} — started`);
              break;
            }
            case "skip_step": {
              if (!stepId) {
                return jsonResult({ success: false, error: "skip_step requires step_id" });
              }
              const skipStep = freshTask.steps.find((s) => s.id === stepId);
              if (!skipStep) {
                return jsonResult({ success: false, error: `Step not found: ${stepId}` });
              }
              skipStep.status = "skipped";
              freshTask.progress.push(`[${stepId}] ${skipStep.content} — skipped`);
              const sortedForSkip = [...freshTask.steps].toSorted((a, b) => a.order - b.order);
              const hasInProgress = sortedForSkip.some((s) => s.status === "in_progress");
              if (!hasInProgress) {
                const nextPendingAfterSkip = sortedForSkip.find((s) => s.status === "pending");
                if (nextPendingAfterSkip) {
                  nextPendingAfterSkip.status = "in_progress";
                }
              }
              break;
            }
            case "reorder_steps": {
              if (!stepsOrder || stepsOrder.length === 0) {
                return jsonResult({
                  success: false,
                  error: "reorder_steps requires steps_order array",
                });
              }
              const stepMap = new Map(freshTask.steps.map((s) => [s.id, s]));
              let order = 1;
              for (const sid of stepsOrder) {
                const s = stepMap.get(sid);
                if (s) {
                  s.order = order++;
                }
              }
              for (const s of freshTask.steps) {
                if (!stepsOrder.includes(s.id)) {
                  s.order = order++;
                }
              }
              freshTask.progress.push(`Steps reordered: ${stepsOrder.join(", ")}`);
              break;
            }
            default:
              return jsonResult({
                success: false,
                error: `Unknown action: ${action}. Valid: set_steps, add_step, complete_step, start_step, skip_step, reorder_steps`,
              });
          }
        }

        await writeTask(workspaceDir, freshTask);
        emit({
          type: EVENT_TYPES.TASK_UPDATED,
          agentId,
          ts: Date.now(),
          data: {
            taskId: freshTask.id,
            progressCount: freshTask.progress.length,
            workSessionId: freshTask.workSessionId,
          },
        });
        await updateCurrentTaskPointer(workspaceDir, freshTask.id);

        const stepsInfo = freshTask.steps?.length
          ? {
              totalSteps: freshTask.steps.length,
              done: freshTask.steps.filter((s) => s.status === "done").length,
              inProgress: freshTask.steps.filter((s) => s.status === "in_progress").length,
              pending: freshTask.steps.filter((s) => s.status === "pending").length,
              skipped: freshTask.steps.filter((s) => s.status === "skipped").length,
            }
          : undefined;

        return jsonResult({
          success: true,
          taskId: freshTask.id,
          updated: now,
          progressCount: freshTask.progress.length,
          workSessionId: freshTask.workSessionId,
          steps: stepsInfo,
        });
      } finally {
        await lock.release();
      }
    },
  };
}

export function createTaskCompleteTool(options: {
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
    label: "Task Complete",
    name: "task_complete",
    description:
      "Mark a task as complete. If task_id is omitted, completes the most recent in_progress task. Archives the task to TASK_HISTORY.md and removes the task file.",
    parameters: TaskCompleteSchema,
    execute: async (_toolCallId, params) => {
      const taskIdParam = readStringParam(params, "task_id");
      const summary = readStringParam(params, "summary");

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
            error: "No active task to complete.",
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
        if (!freshTask) {
          return jsonResult({
            success: false,
            error: `Task ${task.id} was deleted during lock acquisition`,
          });
        }

        // ─── STOP GUARD (delegated to task-stop-guard.ts) ───
        const guardResult = checkStopGuard(freshTask);
        if (guardResult.blocked) {
          const forceComplete = readStringParam(params, "force_complete");

          if (forceComplete !== "true") {
            freshTask.progress.push(
              `Stop Guard: task_complete blocked — ${guardResult.incompleteSteps?.length ?? 0} steps remaining`,
            );
            freshTask.lastActivity = new Date().toISOString();
            await writeTask(workspaceDir, freshTask);

            return jsonResult({
              success: false,
              blocked_by: "stop_guard",
              error: guardResult.reason,
              remaining_steps: guardResult.incompleteSteps,
              instructions: [
                "Complete remaining steps: task_update(action: 'complete_step', step_id: '...')",
                "Or skip them: task_update(action: 'skip_step', step_id: '...')",
                "Or force complete: task_complete(force_complete: 'true')",
              ],
            });
          } else {
            const incomplete = guardResult.incompleteSteps ?? [];
            freshTask.progress.push(
              `Force completed with ${incomplete.length} steps remaining: ${incomplete.map((s) => s.id).join(", ")}`,
            );
          }
        }
        // ─── END STOP GUARD ───

        freshTask.progress.push("Task completed");
        freshTask.status = "completed";
        freshTask.outcome = { kind: "completed", summary };

        const historyEntry = formatTaskHistoryEntry(freshTask, summary);

        await writeTask(workspaceDir, freshTask);
        emit({
          type: EVENT_TYPES.TASK_COMPLETED,
          agentId,
          ts: Date.now(),
          data: { taskId: freshTask.id, workSessionId: freshTask.workSessionId },
        });

        const archivedTo = await appendToHistory(workspaceDir, historyEntry);

        await deleteTask(workspaceDir, freshTask.id);

        const remainingTasks = await listTasks(workspaceDir);
        const nextTask = remainingTasks.find((t) => t.status === "in_progress") || null;

        await updateCurrentTaskPointer(workspaceDir, nextTask?.id || null);

        if (!(await hasActiveTasks(workspaceDir))) {
          disableAgentManagedMode(agentId);
        }

        if (freshTask.milestoneId && freshTask.milestoneItemId) {
          const hubUrl = process.env.TASK_HUB_URL || "http://localhost:3102";
          try {
            await retryAsync(
              async () => {
                const resp = await fetch(
                  `${hubUrl}/api/milestones/${freshTask.milestoneId}/items/${freshTask.milestoneItemId}`,
                  {
                    method: "PUT",
                    headers: {
                      "Content-Type": "application/json",
                      Cookie: "task-hub-session=authenticated",
                    },
                    body: JSON.stringify({ status: "done" }),
                  },
                );
                if (!resp.ok) {
                  throw new Error(`Milestone sync HTTP ${resp.status}`);
                }
              },
              { attempts: 3, minDelayMs: 500, maxDelayMs: 5000, label: "milestone-sync" },
            );
          } catch (err) {
            log.warn("Milestone sync failed after retries", {
              taskId: freshTask.id,
              milestoneId: freshTask.milestoneId,
              error: String(err),
            });
            emit({
              type: EVENT_TYPES.MILESTONE_SYNC_FAILED,
              agentId,
              ts: Date.now(),
              data: {
                taskId: freshTask.id,
                milestoneId: freshTask.milestoneId,
                workSessionId: freshTask.workSessionId,
              },
            });
          }
        }

        return jsonResult({
          success: true,
          taskId: freshTask.id,
          archived: true,
          archivedTo,
          completedAt: new Date().toISOString(),
          workSessionId: freshTask.workSessionId,
          remainingTasks: remainingTasks.length,
          nextTaskId: nextTask?.id || null,
        });
      } finally {
        await lock.release();
      }
    },
  };
}

export function createTaskStatusTool(options: {
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
    label: "Task Status",
    name: "task_status",
    description:
      "Get task status. If task_id is provided, returns that specific task. Otherwise returns a summary of all active tasks.",
    parameters: TaskStatusSchema,
    execute: async (_toolCallId, params) => {
      const taskIdParam = readStringParam(params, "task_id");

      if (taskIdParam) {
        const task = await readTask(workspaceDir, taskIdParam);
        if (!task) {
          return jsonResult({
            found: false,
            error: `Task not found: ${taskIdParam}`,
          });
        }
        const stepsInfo = task.steps?.length
          ? {
              steps: [...task.steps]
                .toSorted((a, b) => a.order - b.order)
                .map((s) => ({
                  id: s.id,
                  content: s.content,
                  status: s.status,
                })),
              totalSteps: task.steps.length,
              done: task.steps.filter((s) => s.status === "done").length,
              inProgress: task.steps.filter((s) => s.status === "in_progress").length,
              pending: task.steps.filter((s) => s.status === "pending").length,
              skipped: task.steps.filter((s) => s.status === "skipped").length,
            }
          : undefined;

        return jsonResult({
          found: true,
          task: {
            id: task.id,
            status: task.status,
            priority: task.priority,
            description: task.description,
            context: task.context,
            created: task.created,
            lastActivity: task.lastActivity,
            workSessionId: task.workSessionId,
            progressCount: task.progress.length,
            latestProgress: task.progress[task.progress.length - 1],
            ...(stepsInfo ? stepsInfo : {}),
          },
        });
      }

      const allTasks = await listTasks(workspaceDir);
      const activeTask = await findActiveTask(workspaceDir);

      return jsonResult({
        totalTasks: allTasks.length,
        byStatus: {
          in_progress: allTasks.filter((t) => t.status === "in_progress").length,
          pending: allTasks.filter((t) => t.status === "pending").length,
          pending_approval: allTasks.filter((t) => t.status === "pending_approval").length,
          blocked: allTasks.filter((t) => t.status === "blocked").length,
        },
        currentFocus: activeTask
          ? {
              id: activeTask.id,
              description: activeTask.description,
              priority: activeTask.priority,
              workSessionId: activeTask.workSessionId,
            }
          : null,
        tasks: allTasks.map((t) => ({
          id: t.id,
          status: t.status,
          priority: t.priority,
          description: t.description.slice(0, 50) + (t.description.length > 50 ? "..." : ""),
          workSessionId: t.workSessionId,
        })),
      });
    },
  };
}

export function createTaskListTool(options: {
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
    label: "Task List",
    name: "task_list",
    description:
      "List all tasks. Optionally filter by status: 'all', 'pending', 'pending_approval', 'in_progress', 'blocked', 'backlog'. Use scope='all' to aggregate tasks from ALL agents. Returns tasks sorted by priority then creation time.",
    parameters: TaskListSchema,
    execute: async (_toolCallId, params) => {
      const statusParam = readStringParam(params, "status") || "all";
      const scopeParam = readStringParam(params, "scope");
      const statusFilter = [
        "all",
        "pending",
        "pending_approval",
        "in_progress",
        "blocked",
        "backlog",
      ].includes(statusParam)
        ? (statusParam as TaskStatus | "all")
        : "all";

      // M7: scope='all' aggregates tasks from all agents
      if (scopeParam === "all" && cfg) {
        const allAgentIds = listAgentIds(cfg);
        const aggregated: Array<{
          agentId: string;
          id: string;
          status: string;
          priority: string;
          description: string;
          created: string;
          lastActivity: string;
          workSessionId?: string;
          progressCount: number;
          stepsTotal?: number;
          stepsDone?: number;
        }> = [];
        for (const aid of allAgentIds) {
          const ws = resolveAgentWorkspaceDir(cfg, aid);
          const agentTasks = await listTasks(ws, statusFilter);
          for (const t of agentTasks) {
            aggregated.push({
              agentId: aid,
              id: t.id,
              status: t.status,
              priority: t.priority,
              description: t.description,
              created: t.created,
              lastActivity: t.lastActivity,
              workSessionId: t.workSessionId,
              progressCount: t.progress.length,
              ...(t.steps?.length
                ? {
                    stepsTotal: t.steps.length,
                    stepsDone: t.steps.filter((s) => s.status === "done").length,
                  }
                : {}),
            });
          }
        }
        return jsonResult({
          filter: statusFilter,
          scope: "all",
          count: aggregated.length,
          tasks: aggregated,
        });
      }

      const tasks = await listTasks(workspaceDir, statusFilter);

      return jsonResult({
        filter: statusFilter,
        count: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          status: t.status,
          priority: t.priority,
          description: t.description,
          created: t.created,
          lastActivity: t.lastActivity,
          workSessionId: t.workSessionId,
          progressCount: t.progress.length,
          ...(t.steps?.length
            ? {
                stepsTotal: t.steps.length,
                stepsDone: t.steps.filter((s) => s.status === "done").length,
              }
            : {}),
        })),
      });
    },
  };
}

export function createTaskCancelTool(options: {
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
    label: "Task Cancel",
    name: "task_cancel",
    description:
      "Cancel a task without completing it. The task is archived to history with cancelled status and removed from active tasks.",
    parameters: TaskCancelSchema,
    execute: async (_toolCallId, params) => {
      const taskId = readStringParam(params, "task_id", { required: true });
      const reason = readStringParam(params, "reason");

      const task = await readTask(workspaceDir, taskId);
      if (!task) {
        return jsonResult({
          success: false,
          error: `Task not found: ${taskId}`,
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
        task.status = "cancelled";
        task.outcome = { kind: "cancelled", reason };
        task.progress.push(`Task cancelled${reason ? `: ${reason}` : ""}`);

        await writeTask(workspaceDir, task);
        emit({
          type: EVENT_TYPES.TASK_CANCELLED,
          agentId,
          ts: Date.now(),
          data: { taskId: task.id, reason, workSessionId: task.workSessionId },
        });

        const historyEntry = formatTaskHistoryEntry(
          task,
          reason ? `Cancelled: ${reason}` : "Cancelled",
        );
        await appendToHistory(workspaceDir, historyEntry);

        await deleteTask(workspaceDir, task.id);

        const remainingTasks = await listTasks(workspaceDir);
        const nextTask = remainingTasks.find((t) => t.status === "in_progress") || null;

        await updateCurrentTaskPointer(workspaceDir, nextTask?.id || null);

        if (!(await hasActiveTasks(workspaceDir))) {
          disableAgentManagedMode(agentId);
        }

        if (task.milestoneId && task.milestoneItemId) {
          const hubUrl = process.env.TASK_HUB_URL || "http://localhost:3102";
          try {
            await retryAsync(
              async () => {
                const resp = await fetch(
                  `${hubUrl}/api/milestones/${task.milestoneId}/items/${task.milestoneItemId}`,
                  {
                    method: "PUT",
                    headers: {
                      "Content-Type": "application/json",
                      Cookie: "task-hub-session=authenticated",
                    },
                    body: JSON.stringify({ status: "cancelled" }),
                  },
                );
                if (!resp.ok) {
                  throw new Error(`Milestone sync HTTP ${resp.status}`);
                }
              },
              { attempts: 3, minDelayMs: 500, maxDelayMs: 5000, label: "milestone-sync" },
            );
          } catch (err) {
            log.warn("Milestone sync failed after retries", {
              taskId: task.id,
              milestoneId: task.milestoneId,
              error: String(err),
            });
            emit({
              type: EVENT_TYPES.MILESTONE_SYNC_FAILED,
              agentId,
              ts: Date.now(),
              data: {
                taskId: task.id,
                milestoneId: task.milestoneId,
                workSessionId: task.workSessionId,
              },
            });
          }
        }

        return jsonResult({
          success: true,
          taskId: task.id,
          cancelled: true,
          reason: reason || null,
          workSessionId: task.workSessionId,
          remainingTasks: remainingTasks.length,
        });
      } finally {
        await lock.release();
      }
    },
  };
}
