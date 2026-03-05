/**
 * Discord System Access Control - Resolution Logic
 * 
 * Resolves the effective access level for a Discord user based on:
 * 1. Owner check (highest priority - full access)
 * 2. User-specific grants
 * 3. Role-based grants (highest level wins)
 * 4. Default level (fallback)
 */

import type {
  SystemAccessConfig,
  SystemAccessGrant,
  SystemAccessLevel,
  ResolvedSystemAccess,
} from "./system-access-types.js";
import { isGrantExpired } from "./system-access-types.js";

export type { ResolvedSystemAccess };

/**
 * Resolve the effective system access level for a Discord user
 */
export function resolveDiscordSystemAccess(params: {
  userId: string;
  userRoles?: string[];  // Discord role IDs the user has
  guildId?: string;
  systemAccessConfig?: SystemAccessConfig;
}): ResolvedSystemAccess {
  const config = params.systemAccessConfig;

  // If system access is disabled, everyone gets Level 0
  if (!config?.enabled) {
    return {
      level: 0,
      isOwner: false,
      source: "default",
    };
  }

  const defaultLevel = config.defaultLevel ?? 0;
  const owner = config.owner?.trim();

  // Priority 1: Owner check (full access)
  if (owner && params.userId === owner) {
    return {
      level: 4,  // Owners get max level (we treat them as infinite, but 4 is practical max)
      isOwner: true,
      source: "owner",
    };
  }

  // Priority 2: User-specific grant
  const userGrant = config.users?.[params.userId];
  if (userGrant && !isGrantExpired(userGrant)) {
    return {
      level: userGrant.level,
      isOwner: false,
      source: "user",
      grantInfo: userGrant,
    };
  }

  // Priority 3: Role-based grant (highest level wins)
  if (params.userRoles && config.roles) {
    let highestRoleLevel: SystemAccessLevel = -1 as SystemAccessLevel;
    let highestRoleId: string | undefined;
    let highestRoleGrant: SystemAccessGrant | undefined;

    for (const roleId of params.userRoles) {
      const roleGrant = config.roles[roleId];
      if (!roleGrant || isGrantExpired(roleGrant)) {
        continue;
      }
      if (roleGrant.level > highestRoleLevel) {
        highestRoleLevel = roleGrant.level;
        highestRoleId = roleId;
        highestRoleGrant = roleGrant;
      }
    }

    if (highestRoleLevel >= 0) {
      return {
        level: highestRoleLevel,
        isOwner: false,
        source: "role",
        grantInfo: highestRoleGrant,
        roleId: highestRoleId,
      };
    }
  }

  // Priority 4: Default level
  return {
    level: defaultLevel,
    isOwner: false,
    source: "default",
  };
}

/**
 * Check if a user is the owner
 */
export function isDiscordOwner(params: {
  userId: string;
  systemAccessConfig?: SystemAccessConfig;
}): boolean {
  const owner = params.systemAccessConfig?.owner?.trim();
  return Boolean(owner && params.userId === owner);
}

/**
 * Format access level for display
 */
export function formatAccessLevel(level: SystemAccessLevel | number): string {
  const levelMap: Record<number, string> = {
    0: "Level 0: Chat Only",
    1: "Level 1: Information Reader",
    2: "Level 2: Content Editor",
    3: "Level 3: Developer",
    4: "Level 4: System Administrator",
  };
  return levelMap[level] ?? `Level ${level}`;
}

/**
 * Get a human-readable description of what access level allows
 */
export function getAccessLevelDescription(level: SystemAccessLevel): string {
  const descriptions: Record<SystemAccessLevel, string> = {
    0: "Can chat and use informational tools (web search, etc.)",
    1: "Can read files and search memory",
    2: "Can create and edit files",
    3: "Can execute commands and manage processes",
    4: "Full system administration access",
  };
  return descriptions[level];
}

/**
 * Validate a system access grant
 */
export function validateSystemAccessGrant(grant: unknown): grant is SystemAccessGrant {
  if (!grant || typeof grant !== "object") {
    return false;
  }
  const g = grant as Partial<SystemAccessGrant>;
  if (typeof g.level !== "number" || g.level < 0 || g.level > 4) {
    return false;
  }
  if (g.expiresAt && typeof g.expiresAt !== "string") {
    return false;
  }
  return true;
}
