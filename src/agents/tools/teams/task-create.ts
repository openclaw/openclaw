/**
 * TaskCreate Tool
 * Adds new tasks to the team ledger
 */

import { Type } from "@sinclair/typebox";
import { getTeamManager } from "../../../teams/pool.js";
import { validateTeamNameOrThrow } from "../../../teams/storage.js";
import type { AnyAgentTool } from "../common.js";
import { jsonResult, readStringParam } from "../common.js";

const TaskCreateSchema = Type.Object({
  team_name: Type.String({ minLength: 1, maxLength: 50 }),
  subject: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ minLength: 1, maxLength: 10000 }),
  activeForm: Type.Optional(Type.String({ maxLength: 100 })),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export function createTaskCreateTool(_opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Task Create",
    name: "task_create",
    description: "Adds a new task to the team ledger.",
    parameters: TaskCreateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      // Extract and validate parameters
      const teamName = readStringParam(params, "team_name", { required: true });
      const subject = readStringParam(params, "subject", { required: true });
      const description = readStringParam(params, "description", { required: true });
      const activeForm = readStringParam(params, "activeForm");
      const dependsOn = params.dependsOn as string[] | undefined;
      const metadata = params.metadata as Record<string, unknown> | undefined;

      // Validate team name
      validateTeamNameOrThrow(teamName);

      // Get team manager
      const teamsDir = process.env.OPENCLAW_STATE_DIR || process.cwd();
      const manager = getTeamManager(teamName, teamsDir);

      // Create task
      const task = manager.createTask(subject, description, {
        activeForm,
        metadata,
      });

      // Handle dependsOn if provided
      if (dependsOn && dependsOn.length > 0) {
        for (const depId of dependsOn) {
          manager.addTaskDependency(task.id, depId);
        }
      }

      return jsonResult({
        taskId: task.id,
        teamName,
        status: "pending",
        message: `Task '${subject}' created with ID ${task.id}`,
      });
    },
  };
}
