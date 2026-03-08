/**
 * Skill Command Handler
 *
 * Handles slash commands that map to skills (e.g. /github, /twitter).
 * Skill commands are registered dynamically based on installed skills.
 * When a skill command is matched, we let it continue through to the
 * agent so the LLM can use the skill's tools and prompt context.
 */

import { logVerbose } from "../../globals.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

/**
 * Handle skill-registered slash commands.
 * Returns a result if a skill command was matched,
 * or null to continue to the next handler.
 */
export const handleSkillCommand: CommandHandler = async (
  params,
  allowTextCommands,
): Promise<CommandHandlerResult | null> => {
  if (!allowTextCommands) {
    return null;
  }

  const { command, skillCommands } = params;
  if (!skillCommands || skillCommands.length === 0) {
    return null;
  }

  const normalized = command.commandBodyNormalized;
  if (!normalized.startsWith("/")) {
    return null;
  }

  // Extract the command name from the normalized body
  const bodyMatch = normalized.match(/^\/(\S+)(?:\s|$)/);
  if (!bodyMatch) {
    return null;
  }
  const commandName = bodyMatch[1].toLowerCase();

  // Match against registered skill commands
  const matchedSpec = skillCommands.find((spec) => spec.name.toLowerCase() === commandName);
  if (!matchedSpec) {
    return null;
  }

  const args = normalized.slice(bodyMatch[0].length).trim();
  logVerbose(
    `Skill command matched: /${commandName} -> skill "${matchedSpec.skillName}"${args ? ` (args: ${args})` : ""}`,
  );

  // Skill commands should flow through to the LLM agent with the
  // skill context already loaded via the workspace skill snapshot.
  // Returning shouldContinue: true lets the message reach the agent.
  return { shouldContinue: true };
};
