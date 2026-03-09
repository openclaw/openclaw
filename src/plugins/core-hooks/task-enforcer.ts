/**
 * Task Enforcer Core Hook
 *
 * Forces agents to call task_start() before any "work" tools (write, edit, bash, etc).
 * When a work tool is called without task_start, it's blocked with a clear error message.
 * The agent retries with task_start first, ensuring 100% task tracking.
 *
 * Now also checks actual task files on disk to recover state after gateway restart.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRegistry } from "../registry.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
} from "../types.js";

const log = createSubsystemLogger("task-enforcer");

const taskStartedSessions = new Map<string, number>();

const SESSION_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let enforcerCleanupTimer: ReturnType<typeof setInterval> | null = null;

const activeTaskCache = new Map<string, { result: boolean; cachedAt: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

type ResolvedActiveTask = {
  taskId: string;
  simple: boolean;
  hasSteps: boolean;
};

function cleanupStaleSessions(): void {
  const now = Date.now();
  for (const [key, timestamp] of taskStartedSessions) {
    if (now - timestamp > SESSION_STALE_MS) {
      taskStartedSessions.delete(key);
      log.debug(`Cleaned up stale session: ${key}`);
    }
  }
}

function getCachedActiveTaskResult(agentId: string): boolean | null {
  const entry = activeTaskCache.get(agentId);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    activeTaskCache.delete(agentId);
    return null;
  }
  return entry.result;
}

function setCachedActiveTaskResult(agentId: string, result: boolean): void {
  activeTaskCache.set(agentId, { result, cachedAt: Date.now() });
}

export function invalidateActiveTaskCache(agentId?: string): void {
  if (agentId) {
    activeTaskCache.delete(agentId);
  } else {
    activeTaskCache.clear();
  }
}

/**
 * Tools that are allowed WITHOUT task_start().
 * Everything NOT in this set requires an active task.
 * Keep this list limited to: task management, read-only, and reporting tools.
 */
const EXEMPT_TOOLS = new Set([
  // Task management tools (must be usable to create/manage tasks)
  "task_update",
  "task_list",
  "task_status",
  "task_cancel",
  "task_approve",
  "task_block",
  "task_resume",
  "task_backlog_add",
  "task_pick_backlog",
  "task_verify",
  "task_step_update",
  // Read-only / research tools
  "read",
  "glob",
  "grep",
  "lsp_diagnostics",
  "lsp_symbols",
  "lsp_goto_definition",
  "lsp_find_references",
  "todoread",
  "web_search",
  "web_fetch",
  // Session read-only tools
  "session_read",
  "session_search",
  "session_list",
  "session_info",
  "sessions_list",
  "sessions_history",
  "session_status",
  // A2A communication (tracked separately via event bus)
  "sessions_send",
  // Notification / messaging (non-work)
  "message",
  // Harness reporting (status updates, not work)
  "harness_report_step",
  "harness_report_check",
]);

function getSessionKey(ctx: PluginHookToolContext): string | null {
  if (!ctx.agentId) {
    return null;
  }
  return `${ctx.agentId}:${ctx.sessionKey ?? "main"}`;
}

/**
 * Check if there are active task files in the workspace's tasks/ directory.
 * This recovers state after gateway restart.
 *
 * When sessionKey is provided, only considers task files that were created by that
 * specific session (via the "Created By Session" metadata field). This prevents
 * stale task files from previous sessions from bypassing enforcement in new sessions.
 * Task files without session metadata are ignored (migration period: they will be
 * cleaned up by stale task cleanup).
 */
async function hasActiveTaskFiles(
  workspaceDir: string,
  agentId?: string,
  sessionKey?: string,
): Promise<boolean> {
  const cacheKey = sessionKey ? `${agentId}:${sessionKey}` : agentId;
  if (cacheKey) {
    const cached = getCachedActiveTaskResult(cacheKey);
    if (cached !== null) {
      return cached;
    }
  }
  const tasksDir = path.join(workspaceDir, "tasks");
  try {
    const files = await fs.readdir(tasksDir);
    // Check if any task_*.md files exist
    const hasTaskFiles = files.some((f) => f.startsWith("task_") && f.endsWith(".md"));
    if (!hasTaskFiles) {
      if (cacheKey) {
        setCachedActiveTaskResult(cacheKey, false);
      }
      return false;
    }
    // Read each task file to check if any are in_progress or pending
    for (const file of files) {
      if (!file.startsWith("task_") || !file.endsWith(".md")) {
        continue;
      }
      try {
        const content = await fs.readFile(path.join(tasksDir, file), "utf-8");
        const isActive =
          content.includes("**Status:** in_progress") ||
          content.includes("**Status:** pending") ||
          content.includes("**Status:** pending_approval");
        if (!isActive) {
          continue;
        }

        // Session-scoped check: only match files created by this session
        if (sessionKey) {
          const sessionMatch = content.match(/\*\*Created By Session:\*\*\s*(.+)/);
          if (sessionMatch && sessionMatch[1].trim() === sessionKey) {
            if (cacheKey) {
              setCachedActiveTaskResult(cacheKey, true);
            }
            return true;
          }
          // File has no session metadata or different session — skip
          continue;
        }

        // No session key filter — legacy behavior (agent-wide check)
        if (cacheKey) {
          setCachedActiveTaskResult(cacheKey, true);
        }
        return true;
      } catch {
        continue;
      }
    }
    if (cacheKey) {
      setCachedActiveTaskResult(cacheKey, false);
    }
    return false;
  } catch {
    return false;
  }
}

function parseCurrentTaskId(content: string): string | null {
  const match = content.match(/^\*\*Focus:\*\*\s+(task_[a-z0-9_]+)\s*$/im);
  return match?.[1] ?? null;
}

function resolveWorkspaceDirForEnforcement(ctx: PluginHookToolContext): string | null {
  if (typeof ctx.workspaceDir === "string" && ctx.workspaceDir.trim()) {
    return ctx.workspaceDir.trim();
  }
  if (!ctx.agentId) {
    return null;
  }
  // Fallback only. The runtime-provided workspaceDir above is the authoritative
  // source because some runners resolve agent/workspace differently from the
  // global default config lookup. If this ever regresses to config-only, expect
  // false "TASK TRACKING REQUIRED" or missing "STEPS REQUIRED" decisions.
  const cfg = loadConfig();
  return resolveAgentWorkspaceDir(cfg, ctx.agentId) ?? null;
}

async function resolveActiveTaskForEnforcement(
  workspaceDir: string,
  sessionKey?: string,
): Promise<ResolvedActiveTask | null> {
  const tasksDir = path.join(workspaceDir, "tasks");
  let currentTaskId: string | null = null;
  let focusedTask: ResolvedActiveTask | null = null;
  let fallbackTask: ResolvedActiveTask | null = null;

  try {
    const currentTaskContent = await fs.readFile(
      path.join(workspaceDir, "CURRENT_TASK.md"),
      "utf-8",
    );
    currentTaskId = parseCurrentTaskId(currentTaskContent);
  } catch {
    currentTaskId = null;
  }

  try {
    const files = await fs.readdir(tasksDir);
    for (const file of files) {
      if (!file.startsWith("task_") || !file.endsWith(".md")) {
        continue;
      }

      try {
        const content = await fs.readFile(path.join(tasksDir, file), "utf-8");
        const isActive =
          content.includes("**Status:** in_progress") ||
          content.includes("**Status:** pending") ||
          content.includes("**Status:** pending_approval");
        if (!isActive) {
          continue;
        }

        const resolved = {
          taskId: file.replace(/\.md$/, ""),
          simple: content.includes("**Simple:** true"),
          hasSteps: content.includes("\n## Steps\n"),
        };

        const sessionMatch = content.match(/\*\*Created By Session:\*\*\s*(.+)/);
        if (sessionKey && sessionMatch && sessionMatch[1].trim() === sessionKey) {
          return resolved;
        }

        // Continuation prompts routinely resume work in a fresh session
        // (for example Discord -> main). If recovery only trusts the original
        // Created By Session metadata, the resumed session is forced to open a
        // duplicate task instead of continuing the focused one. CURRENT_TASK.md
        // is the merge-safe tie-breaker: it preserves the intended logical
        // focus task even after the session key changes.
        if (currentTaskId && resolved.taskId === currentTaskId) {
          focusedTask = resolved;
        }

        if (!fallbackTask) {
          fallbackTask = resolved;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  if (focusedTask) {
    return focusedTask;
  }

  if (!sessionKey) {
    return fallbackTask;
  }

  return null;
}

const STALE_TASK_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Clean up stale task files that have been in_progress/pending for longer than
 * the threshold. Marks them as "abandoned" to prevent enforcement bypass.
 */
export async function cleanupStaleTasks(workspaceDir: string, agentId?: string): Promise<number> {
  const tasksDir = path.join(workspaceDir, "tasks");
  let cleaned = 0;
  try {
    const files = await fs.readdir(tasksDir);
    const now = Date.now();
    for (const file of files) {
      if (!file.startsWith("task_") || !file.endsWith(".md")) {
        continue;
      }
      try {
        const filePath = path.join(tasksDir, file);
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs < STALE_TASK_THRESHOLD_MS) {
          continue;
        }
        const content = await fs.readFile(filePath, "utf-8");
        if (
          content.includes("**Status:** in_progress") ||
          content.includes("**Status:** pending")
        ) {
          const updated = content
            .replace("**Status:** in_progress", "**Status:** abandoned")
            .replace("**Status:** pending", "**Status:** abandoned");
          await fs.writeFile(filePath, updated, "utf-8");
          cleaned++;
          log.info("Cleaned up stale task file", { agentId, file });
        }
      } catch {
        continue;
      }
    }
  } catch {
    // tasks dir doesn't exist — nothing to clean
  }
  if (agentId) {
    invalidateActiveTaskCache(agentId);
  }
  return cleaned;
}

export async function taskEnforcerHandler(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
): Promise<PluginHookBeforeToolCallResult | void> {
  const toolName = event.toolName;

  // Exempt sub-agent sessions from task enforcement.
  // Sub-agents (spawned via sessions_spawn) have task tools denied,
  // so they cannot call task_start. Skip enforcement entirely for them.
  if (ctx.sessionKey && ctx.sessionKey.includes("subagent:")) {
    return;
  }

  if (EXEMPT_TOOLS.has(toolName)) {
    return;
  }

  if (toolName === "task_start") {
    const sessionKey = getSessionKey(ctx);
    if (sessionKey) {
      taskStartedSessions.set(sessionKey, Date.now());
      if (ctx.agentId) {
        invalidateActiveTaskCache(ctx.agentId);
      }
      log.debug(`task_start called for session: ${sessionKey}`);
    }
    return;
  }

  if (toolName === "task_complete") {
    const sessionKey = getSessionKey(ctx);
    if (sessionKey) {
      taskStartedSessions.delete(sessionKey);
      if (ctx.agentId) {
        invalidateActiveTaskCache(ctx.agentId);
      }
      log.debug(`task_complete called for session: ${sessionKey}`);
    }
    return;
  }

  // All tools not in EXEMPT_TOOLS require an active task.
  const sessionKey = getSessionKey(ctx);
  if (!sessionKey) {
    return;
  }

  // First check in-memory cache
  let hasStartedTask = taskStartedSessions.has(sessionKey);

  // If not in cache, check actual task files on disk (recovery after restart)
  let activeTaskForSession: ResolvedActiveTask | null = null;
  if (!hasStartedTask && ctx.agentId) {
    try {
      const workspaceDir = resolveWorkspaceDirForEnforcement(ctx);
      if (workspaceDir) {
        activeTaskForSession = await resolveActiveTaskForEnforcement(workspaceDir, ctx.sessionKey);
        const hasTasksOnDisk =
          activeTaskForSession !== null ||
          (await hasActiveTaskFiles(workspaceDir, ctx.agentId, ctx.sessionKey));
        if (hasTasksOnDisk) {
          // Recover state: mark session as having an active task
          taskStartedSessions.set(sessionKey, Date.now());
          hasStartedTask = true;
          log.info(`Recovered task state from disk for session ${sessionKey}`);
        }
      }
    } catch (err) {
      log.debug(`Failed to check task files for ${sessionKey}: ${String(err)}`);
    }
  }

  if (!hasStartedTask) {
    log.info(`Blocking ${toolName} for session ${sessionKey} - task_start not called yet`);
    return {
      block: true,
      blockReason:
        `TASK TRACKING REQUIRED: You must call task_start() before using ${toolName}. ` +
        `This is mandatory for all work. Call task_start() first with a brief description ` +
        `of what you're about to do, then retry this tool.`,
    };
  }

  if (ctx.agentId && !activeTaskForSession) {
    try {
      const workspaceDir = resolveWorkspaceDirForEnforcement(ctx);
      if (workspaceDir) {
        activeTaskForSession = await resolveActiveTaskForEnforcement(workspaceDir, ctx.sessionKey);
      }
    } catch (err) {
      log.debug(`Failed to resolve active task metadata for ${sessionKey}: ${String(err)}`);
    }
  }

  if (activeTaskForSession && !activeTaskForSession.simple && !activeTaskForSession.hasSteps) {
    // Keep this guard strict. Non-simple tasks must define steps before any
    // work tool runs, otherwise Task Hub loses the decomposition the user asked
    // for and later status replies can make the task look "in progress" with
    // no visible plan. Changes here must stay aligned with task_start and the
    // continuation prompt so all three entry points enforce the same contract.
    return {
      block: true,
      blockReason:
        `STEPS REQUIRED: Active task ${activeTaskForSession.taskId} is not marked simple and has no steps. ` +
        `Before using ${toolName}, call task_update(task_id: "${activeTaskForSession.taskId}", action: "set_steps", steps: [...]). ` +
        `Non-simple tasks must define steps before any work tools run so Task Hub can track progress consistently.`,
    };
  }

  return;
}

export function registerTaskEnforcerHook(registry: PluginRegistry): void {
  registry.typedHooks.push({
    pluginId: "core:task-enforcer",
    hookName: "before_tool_call",
    handler: taskEnforcerHandler,
    priority: 1000,
    source: "core",
  });
  if (!enforcerCleanupTimer) {
    enforcerCleanupTimer = setInterval(cleanupStaleSessions, SESSION_CLEANUP_INTERVAL_MS);
    if (enforcerCleanupTimer.unref) {
      enforcerCleanupTimer.unref();
    }
  }
  log.info("Task enforcer hook registered");
}

export function clearTaskEnforcerState(): void {
  taskStartedSessions.clear();
  activeTaskCache.clear();
  if (enforcerCleanupTimer) {
    clearInterval(enforcerCleanupTimer);
    enforcerCleanupTimer = null;
  }
  log.debug("Task enforcer state cleared");
}
export function hasActiveTask(agentId: string, sessionKey?: string): boolean {
  const key = `${agentId}:${sessionKey ?? "main"}`;
  return taskStartedSessions.has(key);
}

/**
 * Mark a session as having an active task.
 * Useful for external initialization (e.g., on gateway start).
 */
export function markTaskStarted(agentId: string, sessionKey?: string): void {
  const key = `${agentId}:${sessionKey ?? "main"}`;
  taskStartedSessions.set(key, Date.now());
}
