/**
 * Configuration parsing for Claude Code-style agent hooks.
 *
 * Reads hook configurations from OpenClaw config and returns
 * the appropriate shell commands to execute for each event.
 */

import type { OpenClawConfig } from "../config/config.js";
import type {
  AgentHookEntry,
  AgentHookEventName,
  AgentHookMatcher,
  ShellHookCommand,
} from "../config/types.hooks.js";

/**
 * Resolved shell hook configuration for execution.
 */
export type ResolvedShellHook = {
  /** Shell command to execute */
  command: string;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Working directory */
  cwd?: string;
};

const DEFAULT_HOOK_TIMEOUT_MS = 30000;

/**
 * Check if a tool name matches a matcher configuration.
 *
 * @param toolName - Name of the tool being used (e.g., 'Bash', 'Read')
 * @param matcher - Matcher configuration (string pattern or object)
 * @returns true if the tool matches
 */
function matchesTool(
  toolName: string | undefined,
  matcher: AgentHookMatcher | string | undefined,
): boolean {
  // No matcher means match everything
  if (matcher === undefined || matcher === "" || matcher === null) {
    return true;
  }

  // String matcher is treated as a regex pattern
  if (typeof matcher === "string") {
    if (matcher === "") {
      return true;
    }
    try {
      const regex = new RegExp(matcher);
      return toolName !== undefined && regex.test(toolName);
    } catch {
      // Invalid regex, fall back to exact match
      return toolName === matcher;
    }
  }

  // Object matcher with toolPattern or toolNames
  if (matcher.toolPattern !== undefined) {
    try {
      const regex = new RegExp(matcher.toolPattern);
      return toolName !== undefined && regex.test(toolName);
    } catch {
      return false;
    }
  }

  if (matcher.toolNames !== undefined && Array.isArray(matcher.toolNames)) {
    return toolName !== undefined && matcher.toolNames.includes(toolName);
  }

  // No tool-specific matcher, match everything
  return true;
}

/**
 * Get configured shell hooks for an agent-level event.
 *
 * @param cfg - OpenClaw configuration
 * @param eventName - The event name (e.g., 'UserPromptSubmit', 'PreToolUse')
 * @param toolName - Optional tool name for PreToolUse/PostToolUse filtering
 * @returns Array of resolved shell hooks to execute
 *
 * @example
 * ```ts
 * const hooks = getConfiguredHooks(config, 'UserPromptSubmit');
 * for (const hook of hooks) {
 *   await executeShellHook(hook.command, input, { timeoutMs: hook.timeoutMs });
 * }
 * ```
 */
export function getConfiguredHooks(
  cfg: OpenClawConfig | undefined,
  eventName: AgentHookEventName,
  toolName?: string,
): ResolvedShellHook[] {
  const agentHooks = cfg?.hooks?.agentHooks;

  // Check if agent hooks are disabled
  if (agentHooks?.enabled === false) {
    return [];
  }

  // Get hook entries for this event
  const entries: AgentHookEntry[] | undefined = agentHooks?.[eventName];

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const resolved: ResolvedShellHook[] = [];

  for (const entry of entries) {
    // Check if matcher allows this tool
    if (!matchesTool(toolName, entry.matcher)) {
      continue;
    }

    // Extract shell commands from hooks array
    const hooks = entry.hooks;
    if (!Array.isArray(hooks)) {
      continue;
    }

    for (const hook of hooks) {
      if (isShellHookCommand(hook)) {
        resolved.push({
          command: hook.command,
          timeoutMs: entry.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
          cwd: entry.cwd,
        });
      }
    }
  }

  return resolved;
}

/**
 * Type guard for ShellHookCommand.
 */
function isShellHookCommand(hook: unknown): hook is ShellHookCommand {
  if (typeof hook !== "object" || hook === null) {
    return false;
  }
  const obj = hook as Record<string, unknown>;
  return obj.type === "command" && typeof obj.command === "string";
}

/**
 * Check if any hooks are configured for an event.
 *
 * @param cfg - OpenClaw configuration
 * @param eventName - The event name
 * @returns true if at least one hook is configured
 */
export function hasConfiguredHooks(
  cfg: OpenClawConfig | undefined,
  eventName: AgentHookEventName,
): boolean {
  const agentHooks = cfg?.hooks?.agentHooks;

  if (agentHooks?.enabled === false) {
    return false;
  }

  const entries = agentHooks?.[eventName];
  return Array.isArray(entries) && entries.length > 0;
}

/**
 * Get all configured event names that have hooks.
 *
 * @param cfg - OpenClaw configuration
 * @returns Array of event names with configured hooks
 */
export function getConfiguredHookEvents(cfg: OpenClawConfig | undefined): AgentHookEventName[] {
  const eventNames: AgentHookEventName[] = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "PreCompact",
  ];

  return eventNames.filter((name) => hasConfiguredHooks(cfg, name));
}
