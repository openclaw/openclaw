/**
 * Global skill security context for the current gateway process.
 *
 * Tracks loaded community skills and their capabilities so the before-tool-call
 * hook can enforce capability-based restrictions without threading skill entries
 * through the entire tool execution pipeline.
 *
 * Updated when skills are loaded (workspace.ts). Read by the before-tool-call
 * enforcement gate (pi-tools.before-tool-call.ts).
 */

import type { SkillCapability } from "../agents/skills/types.js";
import { DANGEROUS_COMMUNITY_SKILL_TOOL_SET, COMMUNITY_SKILL_ALWAYS_DENY_SET } from "./dangerous-tools.js";
import { CAPABILITY_TOOL_GROUP_MAP } from "./dangerous-tools.js";
import { TOOL_GROUPS } from "../agents/tool-policy.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("skills/security");

export type CommunitySkillInfo = {
  name: string;
  capabilities: SkillCapability[];
  scanSeverity: "clean" | "info" | "warn" | "critical";
};

type SkillSecurityState = {
  communitySkills: CommunitySkillInfo[];
  /** Aggregate set of all capabilities declared by loaded community skills. */
  aggregateCapabilities: Set<SkillCapability>;
  /** Tools covered by the aggregate capabilities (expanded from tool groups). */
  coveredTools: Set<string>;
};

let currentState: SkillSecurityState = {
  communitySkills: [],
  aggregateCapabilities: new Set(),
  coveredTools: new Set(),
};

/**
 * Update the skill security context when skills are (re)loaded.
 * Called from workspace.ts after skill entries are built.
 */
export function updateSkillSecurityContext(communitySkills: CommunitySkillInfo[]): void {
  const aggregateCapabilities = new Set<SkillCapability>();
  for (const skill of communitySkills) {
    for (const cap of skill.capabilities) {
      aggregateCapabilities.add(cap);
    }
  }

  // Expand capabilities into the actual tool names they cover
  const coveredTools = new Set<string>();
  for (const cap of aggregateCapabilities) {
    const groupName = CAPABILITY_TOOL_GROUP_MAP[cap];
    if (groupName) {
      const tools = TOOL_GROUPS[groupName];
      if (tools) {
        for (const tool of tools) {
          coveredTools.add(tool);
        }
      }
    }
  }

  currentState = { communitySkills, aggregateCapabilities, coveredTools };

  if (communitySkills.length > 0) {
    log.info(
      `Skill security context updated: ${communitySkills.length} community skill(s), ` +
        `capabilities: [${[...aggregateCapabilities].join(", ")}]`,
      {
        category: "security",
        communitySkillCount: communitySkills.length,
        capabilities: [...aggregateCapabilities],
      },
    );
  }
}

/**
 * Check if a tool call should be blocked based on loaded community skills.
 *
 * Returns null if allowed, or a reason string if blocked.
 */
export function checkToolAgainstSkillPolicy(toolName: string): string | null {
  // No community skills loaded → no restrictions
  if (currentState.communitySkills.length === 0) {
    return null;
  }

  // Always-deny tools: blocked unconditionally when community skills are loaded.
  // These are control-plane / infrastructure tools no community skill should touch.
  if (COMMUNITY_SKILL_ALWAYS_DENY_SET.has(toolName)) {
    log.warn(`Blocked tool "${toolName}": always denied when community skills are loaded`, {
      category: "security",
      tool: toolName,
      reason: "always_denied_with_community_skills",
    });
    return `Tool "${toolName}" is blocked when community skills are loaded (security policy)`;
  }

  // Check dangerous community skill tools that need explicit capability declaration
  if (DANGEROUS_COMMUNITY_SKILL_TOOL_SET.has(toolName)) {
    if (!currentState.coveredTools.has(toolName)) {
      log.warn(
        `Blocked tool "${toolName}": no community skill declares the required capability`,
        {
          category: "security",
          tool: toolName,
          communitySkills: currentState.communitySkills.map((s) => s.name),
          aggregateCapabilities: [...currentState.aggregateCapabilities],
        },
      );
      return `Tool "${toolName}" is blocked: no loaded community skill declares the required capability. ` +
        `Add the appropriate capability to the skill's metadata.openclaw.capabilities field.`;
    }
  }

  // Audit logging for dangerous tool usage when community skills are loaded
  if (DANGEROUS_COMMUNITY_SKILL_TOOL_SET.has(toolName)) {
    log.debug(
      `Dangerous tool "${toolName}" called with community skills loaded`,
      {
        category: "security",
        tool: toolName,
        communitySkills: currentState.communitySkills.map((s) => s.name),
        declaredCapabilities: [...currentState.aggregateCapabilities],
      },
    );
  }

  return null;
}

export function getSkillSecurityState(): Readonly<SkillSecurityState> {
  return currentState;
}

export function hasCommunitySkillsLoaded(): boolean {
  return currentState.communitySkills.length > 0;
}
