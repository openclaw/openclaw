/**
 * Discord System Access Control - Type Definitions
 * 
 * Implements level-based RBAC for Discord users and roles.
 * Default deny (Level 0), graduated access levels, owner always full access.
 */

export type SystemAccessLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Access level definitions:
 * - Level 0: Chat Only (default) - web_search, web_fetch, message, tts
 * - Level 1: Information Reader - read, memory_get
 * - Level 2: Content Editor - write, edit
 * - Level 3: Developer - exec, process, subagents
 * - Level 4: System Administrator - gateway, cron, nodes, browser
 * - Owner: Full access (infinite level)
 */
export const ACCESS_LEVEL_NAMES: Record<SystemAccessLevel, string> = {
  0: "Chat Only",
  1: "Information Reader",
  2: "Content Editor",
  3: "Developer",
  4: "System Administrator",
};

/**
 * Grant metadata for users or roles
 */
export type SystemAccessGrant = {
  level: SystemAccessLevel;
  name?: string;          // Human-readable identifier
  grantedAt?: string;     // ISO timestamp
  grantedBy?: string;     // Discord user ID who granted it
  expiresAt?: string;     // Optional expiry (for temporary access)
  note?: string;          // Optional reason/note
};

/**
 * Audit log configuration
 */
export type SystemAccessAuditConfig = {
  enabled?: boolean;
  path?: string;  // Relative to workspace or absolute
};

/**
 * System access configuration per Discord guild
 */
export type SystemAccessConfig = {
  enabled?: boolean;                              // Master switch (default: false)
  defaultLevel?: SystemAccessLevel;               // Default for all users (default: 0)
  owner?: string;                                 // Primary owner Discord user ID
  users?: Record<string, SystemAccessGrant>;      // User-specific grants
  roles?: Record<string, SystemAccessGrant>;      // Role-based grants
  auditLog?: SystemAccessAuditConfig;
};

/**
 * Resolved access information for a Discord user
 */
export type ResolvedSystemAccess = {
  level: SystemAccessLevel;
  isOwner: boolean;
  source: "owner" | "user" | "role" | "default";
  grantInfo?: SystemAccessGrant;
  roleId?: string;  // If source is "role", which role granted it
};

/**
 * Tool access requirement mapping
 */
export const TOOL_ACCESS_LEVELS: Record<string, SystemAccessLevel> = {
  // Level 0: Chat Only (informational tools)
  "web_search": 0,
  "web_fetch": 0,
  "memory_search": 0,
  "tts": 0,
  "message": 0,
  
  // Level 1: Information Reader (read-only file access)
  "read": 1,
  "memory_get": 1,
  
  // Level 2: Content Editor (write/modify files)
  "write": 2,
  "edit": 2,
  
  // Level 3: Developer (command execution)
  "exec": 3,
  "process": 3,
  "subagents": 3,
  "sessions_spawn": 3,
  
  // Level 4: System Administrator (full control)
  "gateway": 4,
  "cron": 4,
  "nodes": 4,
  "browser": 4,
  "canvas": 4,
  "session_status": 4,
};

/**
 * Default access level for unknown tools (safe default: admin only)
 */
export const DEFAULT_TOOL_ACCESS_LEVEL: SystemAccessLevel = 4;

/**
 * Check if a tool is allowed for a given access level
 */
export function isToolAllowedForLevel(
  toolName: string,
  userLevel: SystemAccessLevel | number,
): boolean {
  const requiredLevel = TOOL_ACCESS_LEVELS[toolName] ?? DEFAULT_TOOL_ACCESS_LEVEL;
  return userLevel >= requiredLevel;
}

/**
 * Get the required access level for a tool
 */
export function getToolRequiredLevel(toolName: string): SystemAccessLevel {
  return TOOL_ACCESS_LEVELS[toolName] ?? DEFAULT_TOOL_ACCESS_LEVEL;
}

/**
 * Check if a grant has expired
 */
export function isGrantExpired(grant: SystemAccessGrant): boolean {
  if (!grant.expiresAt) {
    return false;
  }
  return new Date(grant.expiresAt) < new Date();
}
