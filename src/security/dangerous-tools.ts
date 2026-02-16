// Shared tool-risk constants.
// Keep these centralized so gateway HTTP restrictions, security audits, and ACP prompts don't drift.

/**
 * Tools denied via Gateway HTTP `POST /tools/invoke` by default.
 * These are high-risk because they enable session orchestration, control-plane actions,
 * or interactive flows that don't make sense over a non-interactive HTTP surface.
 */
export const DEFAULT_GATEWAY_HTTP_TOOL_DENY = [
  // Session orchestration — spawning agents remotely is RCE
  "sessions_spawn",
  // Cross-session injection — message injection across sessions
  "sessions_send",
  // Gateway control plane — prevents gateway reconfiguration via HTTP
  "gateway",
  // Interactive setup — requires terminal QR scan, hangs on HTTP
  "whatsapp_login",
] as const;

/**
 * ACP tools that should always require explicit user approval.
 * ACP is an automation surface; we never want "silent yes" for mutating/execution tools.
 */
export const DANGEROUS_ACP_TOOL_NAMES = [
  "exec",
  "spawn",
  "shell",
  "sessions_spawn",
  "sessions_send",
  "gateway",
  "fs_write",
  "fs_delete",
  "fs_move",
  "apply_patch",
] as const;

export const DANGEROUS_ACP_TOOLS = new Set<string>(DANGEROUS_ACP_TOOL_NAMES);

// ---------------------------------------------------------------------------
// Skill capability → tool group mapping.
// Maps human-readable capability names (declared in SKILL.md frontmatter) to
// the existing TOOL_GROUPS in tool-policy.ts.
//
// CLAWHUB ALIGNMENT: Keep in sync with clawhub/convex/lib/skillCapabilities.ts.
// Both OpenClaw and ClawHub validate against the same capability names.
// ---------------------------------------------------------------------------
export const CAPABILITY_TOOL_GROUP_MAP: Record<string, string> = {
  shell: "group:runtime", // exec, process
  filesystem: "group:fs", // read, write, edit, apply_patch
  network: "group:web", // web_search, web_fetch
  browser: "group:ui", // browser, canvas
  sessions: "group:sessions", // sessions_spawn, sessions_send, subagents, etc.
  messaging: "group:messaging", // message
  scheduling: "group:scheduling", // cron
};

/**
 * Tools always denied when community skills are loaded, regardless of
 * capability declarations. These are control-plane / infrastructure tools
 * that no community skill should ever touch.
 */
export const COMMUNITY_SKILL_ALWAYS_DENY = [
  "gateway", // control-plane reconfiguration
  "nodes", // device/node control
] as const;

export const COMMUNITY_SKILL_ALWAYS_DENY_SET = new Set<string>(COMMUNITY_SKILL_ALWAYS_DENY);

/**
 * Tools that require an explicit capability declaration from community skills.
 * If a community skill doesn't declare the matching capability, these tools
 * are blocked at runtime by the before-tool-call hook.
 */
export const DANGEROUS_COMMUNITY_SKILL_TOOLS = [
  // shell capability
  "exec",
  "process",
  "lobster",
  // filesystem capability (mutations only — read is safe and always allowed)
  "write",
  "edit",
  "apply_patch",
  // network capability
  "web_fetch",
  "web_search",
  // browser capability
  "browser",
  // sessions capability
  "sessions_spawn",
  "sessions_send",
  "subagents",
  // messaging capability
  "message",
  // scheduling capability
  "cron",
] as const;

export const DANGEROUS_COMMUNITY_SKILL_TOOL_SET = new Set<string>(DANGEROUS_COMMUNITY_SKILL_TOOLS);
