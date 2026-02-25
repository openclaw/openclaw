/**
 * TaskComplete Tool
 * Marks tasks as completed and unblocks dependent tasks
 * Optionally announces completion to team lead via inbox
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { writeInboxMessage, listMembers } from "../../../teams/inbox.js";
import { getTeamManager } from "../../../teams/pool.js";
import { validateTeamNameOrThrow } from "../../../teams/storage.js";
import type { AnyAgentTool } from "../common.js";
import { jsonResult, readStringParam } from "../common.js";

const TaskCompleteSchema = Type.Object({
  team_name: Type.String({ minLength: 1, maxLength: 50 }),
  task_id: Type.String(),
  summary: Type.Optional(Type.String({ maxLength: 1000 })),
  announce: Type.Optional(Type.Boolean()),
});

export function createTaskCompleteTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Task Complete",
    name: "task_complete",
    description:
      "Marks a task as completed and unblocks dependent tasks. Optionally announces completion to team lead.",
    parameters: TaskCompleteSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      // Extract and validate parameters
      const teamName = readStringParam(params, "team_name", { required: true });
      const taskId = readStringParam(params, "task_id", { required: true });
      const summary = readStringParam(params, "summary");
      const shouldAnnounce = params.announce === true;

      // Validate team name
      validateTeamNameOrThrow(teamName);

      // Get team manager
      const teamsDir = process.env.OPENCLAW_STATE_DIR || process.cwd();
      const manager = getTeamManager(teamName, teamsDir);

      // Complete task (handles ownership verification and unblocking)
      const sessionKey = opts?.agentSessionKey || "unknown";
      const result = manager.completeTask(taskId, sessionKey);

      // Optionally announce completion to team lead
      if (shouldAnnounce) {
        try {
          const config = await manager.getTeamConfig();
          const leadSessionKey = config.lead;

          if (leadSessionKey && leadSessionKey !== sessionKey) {
            // Find the teammate's name from the member list
            const members = await listMembers(teamName, teamsDir);
            const teammate = members.find(
              (m) => (m as { sessionKey?: string }).sessionKey === sessionKey,
            );
            const teammateName =
              (teammate as { name?: string })?.name || sessionKey.split(":").pop() || "Teammate";

            // Create announcement message
            const messageId = randomUUID();
            const announceMessage = {
              id: messageId,
              type: "task_complete",
              from: sessionKey,
              to: leadSessionKey,
              content: summary
                ? `Task ${taskId} completed: ${summary}`
                : `Task ${taskId} completed successfully.`,
              summary: `Task ${taskId} completed by ${teammateName}`,
              taskId,
              completedBy: teammateName,
              timestamp: Date.now(),
            };

            // Write to lead's inbox
            await writeInboxMessage(teamName, teamsDir, leadSessionKey, announceMessage);
          }
        } catch {
          // Announce failure should not block task completion
          // Error is silently ignored - completion still succeeds
        }
      }

      return jsonResult({
        taskId,
        status: "completed",
        unblocked: result.unblocked || [],
        announced: shouldAnnounce,
      });
    },
  };
}
