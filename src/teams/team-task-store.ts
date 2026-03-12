import { randomUUID } from "node:crypto";
import { emitTeamEvent } from "./team-events.js";
import {
  deleteTeamTaskFromDb,
  loadTeamTaskByIdFromDb,
  loadTeamTasksFromDb,
  saveTeamTaskToDb,
} from "./team-store-sqlite.js";
import type { TeamTask, TeamTaskStatus } from "./types.js";

/** Create a new task in a team run. */
export function createTeamTask(opts: {
  teamRunId: string;
  subject: string;
  description: string;
}): TeamTask {
  const task: TeamTask = {
    id: randomUUID(),
    teamRunId: opts.teamRunId,
    subject: opts.subject,
    description: opts.description,
    status: "pending",
    blockedBy: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveTeamTaskToDb(task);
  emitTeamEvent({
    type: "team_task_updated",
    teamRunId: task.teamRunId,
    taskId: task.id,
    status: task.status,
  });
  return task;
}

/** List all tasks for a team run. */
export function listTeamTasks(teamRunId: string): TeamTask[] {
  return loadTeamTasksFromDb(teamRunId);
}

/** Update a task (owner, status, subject, description, blockedBy). */
export function updateTeamTask(
  teamRunId: string,
  taskId: string,
  patch: {
    owner?: string;
    status?: TeamTaskStatus;
    subject?: string;
    description?: string;
    blockedBy?: string[];
  },
): TeamTask | null {
  const task = loadTeamTaskByIdFromDb(teamRunId, taskId);
  if (!task) {
    return null;
  }

  if (patch.owner !== undefined) {
    task.owner = patch.owner;
  }
  if (patch.status !== undefined) {
    task.status = patch.status;
  }
  if (patch.subject !== undefined) {
    task.subject = patch.subject;
  }
  if (patch.description !== undefined) {
    task.description = patch.description;
  }
  if (patch.blockedBy !== undefined) {
    task.blockedBy = patch.blockedBy;
  }
  task.updatedAt = Date.now();

  saveTeamTaskToDb(task);
  emitTeamEvent({ type: "team_task_updated", teamRunId, taskId: task.id, status: task.status });
  return task;
}

/** Delete a task from a team run. */
export function deleteTeamTask(teamRunId: string, taskId: string): boolean {
  const deleted = deleteTeamTaskFromDb(teamRunId, taskId);
  if (deleted) {
    emitTeamEvent({ type: "team_task_updated", teamRunId, taskId, status: "deleted" });
  }
  return deleted;
}

/** Check if a task is blocked (any blockedBy task is not "completed"). */
export function isTaskBlocked(teamRunId: string, taskId: string): boolean {
  const task = loadTeamTaskByIdFromDb(teamRunId, taskId);
  if (!task || task.blockedBy.length === 0) {
    return false;
  }
  return task.blockedBy.some((depId) => {
    const dep = loadTeamTaskByIdFromDb(teamRunId, depId);
    return !dep || dep.status !== "completed";
  });
}
