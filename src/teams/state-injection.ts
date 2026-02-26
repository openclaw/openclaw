/**
 * Team State Injection
 * Injects team state into agent context to prevent context amnesia
 */

import type { SessionEntry } from "../config/sessions/types.js";
import { getTeamManager } from "./pool.js";
import type { TeamState } from "./types.js";

/**
 * Format team state as text for injection into context
 * @param state - The team state to format
 * @returns Formatted string with team information
 */
export function formatTeamState(state: TeamState): string {
  let output = "\n\n=== TEAM STATE ===\n";
  output += `Team: ${state.name} (${state.id})\n`;
  output += `Status: ${state.status}\n`;
  output += `Description: ${state.description || "N/A"}\n\n`;

  output += `Members (${state.members.length}):\n`;
  for (const member of state.members) {
    const role = member.role === "lead" ? "Lead" : "Member";
    output += `  - ${member.name || member.sessionKey} (${role})\n`;
  }

  output += "\nTask Counts:\n";
  output += `  - Pending: ${state.pendingTaskCount}\n`;
  output += `  - In Progress: ${state.inProgressTaskCount}\n`;
  output += `  - Completed: ${state.completedTaskCount}\n`;

  output += "====================\n\n";
  return output;
}

/**
 * Inject team state into agent context
 * Only injects for team lead sessions to prevent context amnesia
 * @param session - The session entry
 * @param stateDir - The state directory path
 * @returns Formatted team state string, or empty string if not applicable
 */
export async function injectTeamState(session: SessionEntry, stateDir: string): Promise<string> {
  if (!session.teamId || session.teamRole !== "lead") {
    return "";
  }

  const manager = getTeamManager(session.teamId, stateDir);
  const state = manager.getTeamState();

  return formatTeamState({
    id: state.teamName,
    name: state.teamName,
    description: state.config.description,
    status: state.status,
    members: state.members.map((m) => ({
      sessionKey: m.sessionKey,
      agentId: m.agentId,
      name: m.name,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
    pendingTaskCount: state.tasks.filter((t) => t.status === "pending").length,
    inProgressTaskCount: state.tasks.filter((t) => t.status === "in_progress").length,
    completedTaskCount: state.tasks.filter((t) => t.status === "completed").length,
  });
}
