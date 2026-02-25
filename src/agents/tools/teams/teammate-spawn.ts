/**
 * TeammateSpawn Tool
 * Creates a teammate session and adds it to the team as a member
 * Uses proper session key format: agent:{agentId}:teammate:{uuid}
 * Creates real Gateway session for teammate lifecycle management
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../../config/config.js";
import { callGateway } from "../../../gateway/call.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { getTeamManager } from "../../../teams/pool.js";
import { teamDirectoryExists, validateTeamNameOrThrow } from "../../../teams/storage.js";
import { AGENT_LANE_SUBAGENT } from "../../lanes.js";
import type { AnyAgentTool } from "../common.js";
import { jsonResult, readStringParam } from "../common.js";
import { createAgentToAgentPolicy } from "../sessions-access.js";

const TeammateSpawnSchema = Type.Object({
  team_name: Type.String({ minLength: 1, maxLength: 50 }),
  name: Type.String({ minLength: 1, maxLength: 100 }),
  agent_id: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
});

/**
 * Build teammate session key in standard format
 * Format: agent:{agentId}:teammate:{uuid}
 */
function buildTeammateSessionKey(agentId: string): string {
  const normalizedId = normalizeAgentId(agentId);
  return `agent:${normalizedId}:teammate:${randomUUID()}`;
}

export function createTeammateSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: unknown;
  agentAccountId?: string;
}): AnyAgentTool {
  return {
    label: "Teammate Spawn",
    name: "teammate_spawn",
    description: "Creates a new teammate agent and adds it to the team.",
    parameters: TeammateSpawnSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      // Extract and validate parameters
      const teamName = readStringParam(params, "team_name", { required: true });
      const name = readStringParam(params, "name", { required: true });
      const agentIdParam = readStringParam(params, "agent_id");

      // Validate team name
      validateTeamNameOrThrow(teamName);

      // Check team exists
      const teamsDir = process.env.OPENCLAW_STATE_DIR || process.cwd();
      if (!(await teamDirectoryExists(teamsDir, teamName))) {
        return jsonResult({
          error: `Team '${teamName}' not found. Please create the team first.`,
        });
      }

      // Get team manager
      const manager = getTeamManager(teamName, teamsDir);
      const config = await manager.getTeamConfig();

      // Verify team is active
      if (config.metadata?.status !== "active") {
        return jsonResult({
          error: `Team '${teamName}' is not active (status: ${config.metadata?.status}).`,
        });
      }

      // Determine agent ID for teammate
      // Use provided agent_id, or team's agent_type, or default to "main"
      const effectiveAgentId = agentIdParam ?? config.agent_type ?? "main";

      // Check agentToAgent policy for cross-agent spawning
      const cfg = loadConfig();
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const requesterAgentId = opts?.agentSessionKey
        ? resolveAgentIdFromSessionKey(opts.agentSessionKey)
        : "main";

      // If spawning a teammate with a different agent ID, check policy
      if (
        effectiveAgentId !== requesterAgentId &&
        !a2aPolicy.isAllowed(requesterAgentId, effectiveAgentId)
      ) {
        return jsonResult({
          error: `Cannot spawn teammate with agent_id '${effectiveAgentId}': denied by tools.agentToAgent policy.`,
        });
      }

      // Generate session key in standard format
      const sessionKey = buildTeammateSessionKey(effectiveAgentId);
      const teammateId = sessionKey.split(":").pop() ?? randomUUID();

      // Create Gateway session for the teammate
      try {
        // Set up session with spawn metadata
        await callGateway({
          method: "sessions.patch",
          params: {
            key: sessionKey,
            spawnDepth: 1, // Teammates are at depth 1 (spawned by lead)
          },
          timeoutMs: 10_000,
        });

        // Set model if provided
        const modelParam = readStringParam(params, "model");
        if (modelParam) {
          await callGateway({
            method: "sessions.patch",
            params: { key: sessionKey, model: modelParam },
            timeoutMs: 10_000,
          });
        }

        // Create the agent session with initial context
        const initialMessage = [
          `[Team Context] You are "${name}", a teammate in team "${teamName}".`,
          "",
          "Available team tools:",
          "- task_list: Find available tasks to work on",
          "- task_claim: Claim a task for yourself",
          "- task_complete: Mark a claimed task as complete",
          "- send_message: Send messages to teammates (direct or broadcast)",
          "- inbox: Check for new messages from teammates",
          "",
          "Workflow:",
          "1. Call task_list to find pending tasks",
          "2. Call task_claim to claim a task you want to work on",
          "3. Do the work required for the task",
          "4. Call task_complete when done",
          "5. Repeat or wait for messages from teammates",
          "",
          `Your session key: ${sessionKey}`,
        ].join("\n");

        const response = await callGateway<{ runId: string }>({
          method: "agent",
          params: {
            message: initialMessage,
            sessionKey,
            deliver: false,
            lane: AGENT_LANE_SUBAGENT,
            spawnedBy: opts?.agentSessionKey,
          },
          timeoutMs: 10_000,
        });

        const runId = response?.runId;

        // Add member to team ledger with session key
        await manager.addMember({
          name,
          sessionKey,
          agentId: effectiveAgentId,
          agentType: "member",
          status: "idle",
        });

        return jsonResult({
          teammateId,
          sessionKey,
          runId,
          agentId: effectiveAgentId,
          name,
          teamName,
          status: "spawned",
          message: `Teammate '${name}' spawned with session key: ${sessionKey}`,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return jsonResult({
          error: `Failed to spawn teammate: ${errorMessage}`,
          sessionKey,
        });
      }
    },
  };
}
