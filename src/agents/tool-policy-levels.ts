/**
 * Discord System Access - Level-Based Tool Policy
 * 
 * Extends OpenClaw's tool policy system with level-based access control.
 * Filters tools based on user's effective access level.
 */

import type { AnyAgentTool } from "./pi-tools.types.js";
import {
  TOOL_ACCESS_LEVELS,
  DEFAULT_TOOL_ACCESS_LEVEL,
  isToolAllowedForLevel,
  getToolRequiredLevel,
  type SystemAccessLevel,
} from "../discord/system-access-types.js";

/**
 * Wrap a tool's execution to enforce access level requirements
 */
function wrapToolExecutionForLevel(
  tool: AnyAgentTool,
  userLevel: SystemAccessLevel | number,
  context?: {
    userId?: string;
    channelId?: string;
    guildId?: string;
  },
): AnyAgentTool {
  const requiredLevel = getToolRequiredLevel(tool.name);
  
  if (userLevel >= requiredLevel || !tool.execute) {
    return tool;
  }

  return {
    ...tool,
    execute: async () => {
      const errorMessage = 
        `Permission denied: Tool "${tool.name}" requires Level ${requiredLevel} access. ` +
        `You have Level ${userLevel} access. Contact the OpenClaw owner to request higher access.`;
      
      // Log the denied attempt for audit
      console.warn(
        `[SECURITY] Tool access denied: tool=${tool.name} ` +
        `required=${requiredLevel} userLevel=${userLevel} ` +
        `userId=${context?.userId} guildId=${context?.guildId} channelId=${context?.channelId}`,
      );
      
      throw new Error(errorMessage);
    },
  };
}

/**
 * Apply level-based tool policy - filter tools based on access level
 * 
 * @param tools - All available tools
 * @param userLevel - User's effective access level (0-4, or higher for owner)
 * @param options - Additional context for logging and error messages
 * @returns Filtered and wrapped tool list
 */
export function applyLevelBasedToolPolicy(
  tools: AnyAgentTool[],
  userLevel: SystemAccessLevel | number,
  options?: {
    userId?: string;
    channelId?: string;
    guildId?: string;
    filterMode?: "remove" | "wrap";  // "remove" = hide tools, "wrap" = show with error
  },
): AnyAgentTool[] {
  const filterMode = options?.filterMode ?? "remove";
  
  const processed = tools.map((tool) => {
    return wrapToolExecutionForLevel(tool, userLevel, options);
  });
  
  if (filterMode === "remove") {
    // Remove tools user can't access (cleaner, AI doesn't see them)
    return processed.filter((tool) => isToolAllowedForLevel(tool.name, userLevel));
  } else {
    // Keep all tools but wrap with error (allows user to see what they're missing)
    return processed;
  }
}

/**
 * Check if a specific tool is allowed for a user's level
 */
export function isToolAllowedForUser(
  toolName: string,
  userLevel: SystemAccessLevel | number,
): boolean {
  return isToolAllowedForLevel(toolName, userLevel);
}

/**
 * Get list of tools available at a specific access level
 */
export function getToolsForLevel(
  tools: AnyAgentTool[],
  level: SystemAccessLevel,
): string[] {
  return tools
    .filter((tool) => isToolAllowedForLevel(tool.name, level))
    .map((tool) => tool.name);
}

/**
 * Get a summary of tool access for a level
 */
export function getToolAccessSummary(
  tools: AnyAgentTool[],
  level: SystemAccessLevel,
): {
  allowed: string[];
  denied: string[];
  total: number;
} {
  const allowed: string[] = [];
  const denied: string[] = [];
  
  for (const tool of tools) {
    if (isToolAllowedForLevel(tool.name, level)) {
      allowed.push(tool.name);
    } else {
      denied.push(tool.name);
    }
  }
  
  return {
    allowed,
    denied,
    total: tools.length,
  };
}
