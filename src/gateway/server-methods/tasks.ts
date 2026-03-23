import { logActivity } from "../../orchestration/activity-log-sqlite.js";
import * as TaskStore from "../../orchestration/task-store-sqlite.js";
import type { TaskPriority, TaskStatus, AuthorType } from "../../orchestration/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type {
  TasksGetParams,
  TasksGetByIdentifierParams,
  TasksListParams,
  TasksCreateParams,
  TasksUpdateParams,
  TasksListCommentsParams,
  TasksAddCommentParams,
} from "../protocol/schema/types.js";
import type { GatewayRequestHandlers } from "./types.js";

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.get": async ({ params, respond }) => {
    try {
      const p = params as unknown as TasksGetParams;
      const task = TaskStore.getTask(p.id);
      if (!task) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Task not found"));
        return;
      }
      respond(true, task);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "tasks.getByIdentifier": async ({ params, respond }) => {
    try {
      const p = params as unknown as TasksGetByIdentifierParams;
      const task = TaskStore.getTaskByIdentifier(p.workspaceId, p.identifier);
      if (!task) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Task not found"));
        return;
      }
      respond(true, task);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "tasks.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as TasksListParams;
      const tasks = TaskStore.listTasks({
        workspaceId: p.workspaceId,
        status: p.status as TaskStatus | undefined,
        assigneeAgentId: p.assigneeAgentId,
        goalId: p.goalId,
        projectId: p.projectId,
      });
      respond(true, { tasks });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "tasks.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as TasksCreateParams;
      const task = TaskStore.createTask({
        workspaceId: p.workspaceId,
        title: p.title,
        description: p.description,
        projectId: p.projectId,
        goalId: p.goalId,
        parentId: p.parentId,
        priority: p.priority as TaskPriority | undefined,
        assigneeAgentId: p.assigneeAgentId,
        billingCode: p.billingCode,
      });
      logActivity({
        workspaceId: task.workspaceId,
        entityType: "task",
        entityId: task.id,
        action: "created",
        details: { title: task.title, identifier: task.identifier },
      });
      respond(true, task);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "tasks.update": async ({ params, respond }) => {
    try {
      const p = params as unknown as TasksUpdateParams;
      const task = TaskStore.updateTask(p.id, {
        title: p.title,
        description: p.description,
        status: p.status as TaskStatus | undefined,
        priority: p.priority as TaskPriority | undefined,
        assigneeAgentId: p.assigneeAgentId,
        billingCode: p.billingCode,
        goalId: p.goalId,
        projectId: p.projectId,
      });
      logActivity({
        workspaceId: task.workspaceId,
        entityType: "task",
        entityId: task.id,
        action: "updated",
        details: { title: task.title, status: task.status },
      });
      respond(true, task);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "tasks.listComments": async ({ params, respond }) => {
    try {
      const p = params as unknown as TasksListCommentsParams;
      const comments = TaskStore.listTaskComments(p.taskId);
      respond(true, { comments });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "tasks.addComment": async ({ params, respond }) => {
    try {
      const p = params as unknown as TasksAddCommentParams;
      // In realistic implementation we would inspect client/roles
      // For Operator1 MVP, we default to user type.
      const authorType: AuthorType = "user";
      const authorId = "system";

      const comment = TaskStore.addTaskComment({
        taskId: p.taskId,
        authorId,
        authorType,
        body: p.body,
      });
      respond(true, comment);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
