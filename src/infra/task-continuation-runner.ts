import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveAgentDir,
} from "../agents/agent-scope.js";
import { createAgentToAgentPolicy } from "../agents/tools/sessions-helpers.js";
import {
  findPickableBacklogTask,
  findActiveTask,
  findBlockedTasks,
  findPendingTasks,
  findPendingApprovalTasks,
  writeTask,
  readTask,
  type TaskFile,
} from "../agents/tools/task-tool.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { agentCommand } from "../commands/agent.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getQueueSize, getActiveTaskCount } from "../process/command-queue.js";
// CommandLane import removed - using agent-specific lanes
import { resolveAgentBoundAccountId } from "../routing/bindings.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { emit } from "./events/bus.js";
import { EVENT_TYPES } from "./events/schemas.js";
import { acquireTaskLock } from "./task-lock.js";
import { updateAgentEntry, readTeamState, findLeadAgent } from "./team-state.js";

const log = createSubsystemLogger("task-continuation");
const TEAM_STATE_DIR = resolveStateDir(process.env);

const DEFAULT_ZOMBIE_TASK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_IDLE_THRESHOLD_MS = 3 * 60 * 1000;
const CONTINUATION_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_UNBLOCK_REQUESTS = 3;
const UNBLOCK_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_UNBLOCK_FAILURES = 3;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CONTEXT_OVERFLOW_RETRIES = 5; // After this many consecutive overflows, stop retrying
const STATE_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Failure-based backoff configuration
const BACKOFF_MS = {
  rate_limit: 1 * 60 * 1000, // 1 minute default (may be overridden by quota reset time)
  billing: 60 * 60 * 1000, // 1 hour
  timeout: 1 * 60 * 1000, // 1 minute
  context_overflow: 30 * 60 * 1000, // 30 minutes (needs manual intervention)
  unknown: 5 * 60 * 1000, // 5 minutes (default)
} as const;

// Minimum backoff for rate limits to avoid hammering the API
const MIN_RATE_LIMIT_BACKOFF_MS = 10 * 1000; // 10 seconds

type FailureReason = keyof typeof BACKOFF_MS;

type ParsedFailure = {
  reason: FailureReason;
  /** Suggested backoff from error message (e.g., "reset after 30s") */
  suggestedBackoffMs?: number;
};

export type TaskContinuationConfig = {
  checkInterval?: string;
  idleThreshold?: string;
  enabled?: boolean;
  zombieTaskTtl?: string;
  channel?: string;
};

export type TaskContinuationRunner = {
  stop: () => void;
  updateConfig: (cfg: OpenClawConfig) => void;
  checkNow: () => Promise<void>;
};

type AgentContinuationState = {
  lastContinuationSentMs: number;
  lastTaskId: string | null;
  /** If set, skip continuation attempts until this timestamp */
  backoffUntilMs?: number;
  /** Number of consecutive failures for exponential backoff */
  consecutiveFailures?: number;
  /** Last failure reason for debugging */
  lastFailureReason?: FailureReason;
};

const agentStates = new Map<string, AgentContinuationState>();

/**
 * Check if an agent is actively processing commands (not just queued).
 * Returns true only if there are pending items OR active execution happening.
 * A queue with size 1 but no active tasks means the item just completed.
 */
function isAgentActivelyProcessing(agentLane: string): boolean {
  const queueSize = getQueueSize(agentLane);
  if (queueSize === 0) {
    return false;
  }
  if (queueSize > 1) {
    return true;
  }
  // Queue size is 1 — could be active or just-completed
  const activeCount = getActiveTaskCount();
  return activeCount > 0;
}

function cleanupStaleAgentStates(): void {
  const now = Date.now();
  for (const [key, state] of agentStates) {
    if (now - state.lastContinuationSentMs > STATE_STALE_MS) {
      agentStates.delete(key);
      log.debug("Cleaned up stale agent state", { agentId: key });
    }
  }
  for (const [key, lastSentMs] of blockedResumeLastSentMs) {
    if (now - lastSentMs > STATE_STALE_MS) {
      blockedResumeLastSentMs.delete(key);
    }
  }
}

/** @internal - For testing only. Clears all agent continuation state. */
export function __resetAgentStates(): void {
  agentStates.clear();
}

/**
 * Parse quota reset time from error message.
 * Looks for patterns like "reset after 30s", "reset after 0s", "retry after 60 seconds"
 */
function parseQuotaResetTimeMs(message: string): number | null {
  // Match patterns like "reset after 30s", "reset after 0s", "retry after 60 seconds"
  const match = message.match(/(?:reset|retry)\s+after\s+(\d+)\s*s(?:econds?)?/i);
  if (match) {
    const seconds = parseInt(match[1], 10);
    if (!isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  return null;
}

/**
 * Parse failure reason from error message.
 * Returns a categorized reason for backoff calculation.
 */
function parseFailureReason(error: unknown): ParsedFailure {
  const message = error instanceof Error ? error.message : String(error);

  // Rate limit / quota exhaustion
  if (/rate.?limit|quota|429|too many requests|all models failed.*rate/i.test(message)) {
    const suggestedBackoffMs = parseQuotaResetTimeMs(message);
    return {
      reason: "rate_limit",
      suggestedBackoffMs: suggestedBackoffMs !== null ? suggestedBackoffMs : undefined,
    };
  }

  // Billing / payment issues
  if (/billing|payment|insufficient|credit/i.test(message)) {
    return { reason: "billing" };
  }

  // Timeout
  if (/timeout|timed out|deadline exceeded/i.test(message)) {
    return { reason: "timeout" };
  }

  // Context overflow
  if (/context.*overflow|token.*limit|too long|max.*token/i.test(message)) {
    return { reason: "context_overflow" };
  }

  return { reason: "unknown" };
}

/**
 * Calculate backoff duration based on failure reason and consecutive failures.
 * Uses exponential backoff with a cap.
 */
function resolveBackoffMs(
  reason: FailureReason,
  consecutiveFailures: number,
  suggestedBackoffMs?: number,
): number {
  // For rate limits with a suggested backoff from the error message, use it
  if (reason === "rate_limit" && suggestedBackoffMs !== undefined) {
    // Apply minimum backoff to avoid hammering, but respect the API's suggestion
    const effectiveBackoff = Math.max(suggestedBackoffMs, MIN_RATE_LIMIT_BACKOFF_MS);
    log.debug("Using quota reset time from error message", {
      suggestedMs: suggestedBackoffMs,
      effectiveMs: effectiveBackoff,
    });
    return effectiveBackoff;
  }

  const baseMs = BACKOFF_MS[reason];
  // Exponential backoff: base * 2^(failures-1), capped at 2 hours
  const multiplier = Math.min(Math.pow(2, Math.max(0, consecutiveFailures - 1)), 8);
  const backoffMs = baseMs * multiplier;
  const maxBackoffMs = 2 * 60 * 60 * 1000; // 2 hours max
  return Math.min(backoffMs, maxBackoffMs);
}

function resolveTaskContinuationConfig(cfg: OpenClawConfig): {
  enabled: boolean;
  checkIntervalMs: number;
  idleThresholdMs: number;
  zombieTaskTtlMs: number;
  channel: string;
} {
  const tcConfig = cfg.agents?.defaults?.taskContinuation;
  const enabled = tcConfig?.enabled ?? true;

  let checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS;
  if (tcConfig?.checkInterval) {
    try {
      checkIntervalMs = parseDurationMs(tcConfig.checkInterval, { defaultUnit: "m" });
    } catch {
      checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS;
    }
  }

  let idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS;
  if (tcConfig?.idleThreshold) {
    try {
      idleThresholdMs = parseDurationMs(tcConfig.idleThreshold, { defaultUnit: "m" });
    } catch {
      idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS;
    }
  }

  let zombieTaskTtlMs = DEFAULT_ZOMBIE_TASK_TTL_MS;
  if (tcConfig?.zombieTaskTtl) {
    try {
      zombieTaskTtlMs = parseDurationMs(tcConfig.zombieTaskTtl, { defaultUnit: "h" });
    } catch {
      zombieTaskTtlMs = DEFAULT_ZOMBIE_TASK_TTL_MS;
    }
  }

  const channel = tcConfig?.channel ?? "discord";
  return { enabled, checkIntervalMs, idleThresholdMs, zombieTaskTtlMs, channel };
}

function formatUnblockRequestPrompt(blockedAgentId: string, task: TaskFile): string {
  const lines = [
    `[SYSTEM - UNBLOCK REQUEST]`,
    ``,
    `Agent "${blockedAgentId}" needs your help to continue their task.`,
    ``,
    `**Blocked Task ID:** ${task.id}`,
    `**Task Description:** ${task.description}`,
    `**Blocked Reason:** ${task.blockedReason || "No reason provided"}`,
  ];

  if (task.unblockedAction) {
    lines.push(`**Required Action:** ${task.unblockedAction}`);
  }

  if (task.progress.length > 0) {
    const lastProgress = task.progress[task.progress.length - 1];
    lines.push(`**Latest Progress:** ${lastProgress}`);
  }

  lines.push(``);
  lines.push(`Please help unblock this task by taking the necessary action.`);
  lines.push(``);
  lines.push(
    `**IMPORTANT:** After completing the required action, you MUST notify agent "${blockedAgentId}" so they can resume their blocked task.`,
  );
  lines.push(
    `Use sessions_send(target="agent:${blockedAgentId}:main", message="[UNBLOCK RESOLVED] I have completed the required action for task ${task.id}. You can now call task_resume(task_id="${task.id}") to continue your work.") to notify them.`,
  );

  return lines.join("\n");
}

function formatUnblockEscalationPrompt(
  blockedAgentId: string,
  task: TaskFile,
  targetAgentId: string,
): string {
  const lines = [
    `[ESCALATION - UNBLOCK REQUEST (Final Attempt)]`,
    ``,
    `⚠️ Agent "${blockedAgentId}"의 작업이 차단되어 있으며, 이전 내부 요청(2회)으로 해결되지 않았습니다.`,
    `이것은 마지막 자동 시도입니다. 해결되지 않으면 수동 개입이 필요합니다.`,
    ``,
    `**차단된 태스크:** ${task.description}`,
    `**차단 사유:** ${task.blockedReason || "사유 없음"}`,
  ];

  if (task.unblockedAction) {
    lines.push(`**필요한 조치:** ${task.unblockedAction}`);
  }

  lines.push(``);
  lines.push(
    `${targetAgentId}에게: 위 조치를 완료한 후 반드시 agent "${blockedAgentId}"에게 알려주세요.`,
  );
  lines.push(
    `Use sessions_send(target="agent:${blockedAgentId}:main", message="[UNBLOCK RESOLVED] Task ${task.id} resolved. Call task_resume(task_id="${task.id}") to continue.") to notify them.`,
  );

  return lines.join("\n");
}

function formatContinuationPrompt(task: TaskFile, pendingCount: number): string {
  const lines = [
    `[SYSTEM REMINDER - TASK CONTINUATION]`,
    ``,
    `You have an in_progress task that needs attention:`,
    ``,
    `**Task ID:** ${task.id}`,
    `**Description:** ${task.description}`,
    `**Priority:** ${task.priority}`,
    `**Last Activity:** ${task.lastActivity}`,
  ];

  if (task.steps && task.steps.length > 0) {
    lines.push(``);
    lines.push(`**Steps:**`);
    const sortedSteps = [...task.steps].toSorted((a, b) => a.order - b.order);
    for (const step of sortedSteps) {
      const marker =
        step.status === "done"
          ? "✅"
          : step.status === "in_progress"
            ? "▶"
            : step.status === "skipped"
              ? "⏭"
              : "□";
      lines.push(`${marker} (${step.id}) ${step.content}`);
    }
    const incomplete = task.steps.filter(
      (s) => s.status === "pending" || s.status === "in_progress",
    );
    if (incomplete.length > 0) {
      const current = task.steps.find((s) => s.status === "in_progress");
      lines.push(``);
      if (current) {
        lines.push(`Continue from: **${current.content}**`);
      } else {
        lines.push(`Start the next pending step.`);
      }
      lines.push(
        `Use task_update(action: "complete_step", step_id: "...") when each step is done.`,
      );
    }
  } else if (task.progress.length > 0) {
    const lastProgress = task.progress[task.progress.length - 1];
    lines.push(`**Latest Progress:** ${lastProgress}`);
  }

  lines.push(``);
  lines.push(
    `Please continue working on this task. Use task_update() to log progress and task_complete() when finished.`,
  );
  lines.push(``);
  lines.push(
    `When completing, provide a structured summary in the 'summary' parameter:`,
    ``,
    `## 작업 요약`,
    `{한 줄 요약}`,
    ``,
    `## 변경 내용`,
    `- {변경 1}`,
    `- {변경 2}`,
    ``,
    `## 참고 사항`,
    `{없으면 생략 가능}`,
  );

  // Instruct agent to report results to the originating Discord channel
  if (task.createdBySessionKey) {
    const channelMatch = task.createdBySessionKey.match(/discord:channel:(\d+)/);
    if (channelMatch) {
      lines.push(``);
      lines.push(
        `**IMPORTANT:** This task was started from Discord channel ${channelMatch[1]}. When you complete this task or make significant progress, you MUST report your results to that Discord channel so the team can see your work.`,
      );
    }
  }

  if (pendingCount > 0) {
    lines.push(``);
    lines.push(`Note: You have ${pendingCount} more pending task(s) waiting after this one.`);
  }

  return lines.join("\n");
}

function formatBacklogPickupPrompt(task: TaskFile): string {
  const lines = [
    `[SYSTEM REMINDER - BACKLOG PICKUP]`,
    ``,
    `A backlog task is ready to be worked on:`,
    ``,
    `**Task ID:** ${task.id}`,
    `**Description:** ${task.description}`,
    `**Priority:** ${task.priority}`,
  ];

  if (task.createdBy && task.createdBy !== task.assignee) {
    lines.push(`**Requested by:** ${task.createdBy}`);
  }

  if (task.estimatedEffort) {
    lines.push(`**Estimated Effort:** ${task.estimatedEffort}`);
  }

  if (task.dueDate) {
    lines.push(`**Due Date:** ${task.dueDate}`);
  }

  if (task.context) {
    lines.push(``);
    lines.push(`**Context:** ${task.context}`);
  }

  // Harness protocol injection
  if (task.harnessProjectSlug) {
    lines.push(``);
    lines.push(`## Harness Protocol`);
    lines.push(`This is a harness-managed task. You MUST follow the harness protocol:`);
    lines.push(`- **Harness Item ID:** ${task.harnessItemId}`);
    lines.push(`- **Project Slug:** ${task.harnessProjectSlug}`);
    lines.push(``);
    lines.push(`1. Read \`.harness/${task.harnessProjectSlug}/specs/\` for spec files`);
    lines.push(`2. Follow each spec's steps in order`);
    lines.push(
      `3. After completing each step, call \`harness_report_step(item_id="${task.harnessItemId}", step_index=N, status="done")\``,
    );
    lines.push(
      `4. After all steps, verify each checklist item and call \`harness_report_check(item_id="${task.harnessItemId}", check_index=N, passed=true/false)\``,
    );
    lines.push(`5. Only mark task complete after ALL checks pass`);
  }

  lines.push(``);
  lines.push(`**IMPORTANT:** This task is already set to in_progress with Task ID ${task.id}.`);
  lines.push(`DO NOT call task_start() — the task already exists.`);
  lines.push(`Use task_update(task_id="${task.id}", progress="...") to log progress.`);
  lines.push(`Use task_complete(task_id="${task.id}", result="...") when finished.`);
  lines.push(``);
  lines.push(
    `When completing, provide a structured summary in the 'summary' parameter:`,
    ``,
    `## 작업 요약`,
    `{한 줄 요약}`,
    ``,
    `## 변경 내용`,
    `- {변경 1}`,
    `- {변경 2}`,
    ``,
    `## 참고 사항`,
    `{없으면 생략 가능}`,
  );

  // Instruct agent to report results to the originating Discord channel
  if (task.createdBySessionKey) {
    const channelMatch = task.createdBySessionKey.match(/discord:channel:(\d+)/);
    if (channelMatch) {
      lines.push(``);
      lines.push(
        `**IMPORTANT:** This task was started from Discord channel ${channelMatch[1]}. When you complete this task or make significant progress, you MUST report your results to that Discord channel so the team can see your work.`,
      );
    }
  }

  return lines.join("\n");
}

async function checkAgentForContinuation(
  cfg: OpenClawConfig,
  agentId: string,
  idleThresholdMs: number,
  nowMs: number,
): Promise<boolean> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  // Fix #1: Per-agent lock to prevent duplicate continuation prompts
  const continuationLock = await acquireTaskLock(workspaceDir, `continuation_${agentId}`);
  if (!continuationLock) {
    log.debug("Continuation check already running for agent, skipping", { agentId });
    return false;
  }

  try {
    // Check agent-specific queue, not global main queue
    // Agent lanes follow pattern: session:agent:{agentId}:main
    const agentLane = `session:agent:${agentId}:main`;
    if (isAgentActivelyProcessing(agentLane)) {
      log.debug("Agent busy, skipping continuation check", { agentId });
      return false;
    }

    const activeTask = await findActiveTask(workspaceDir);
    if (!activeTask) {
      const pendingTasks = await findPendingTasks(workspaceDir);
      const approvalTasks = await findPendingApprovalTasks(workspaceDir);
      if (pendingTasks.length > 0 || approvalTasks.length > 0) {
        log.debug("Agent has pending/approval tasks, skipping backlog pickup", { agentId });
        return false;
      }

      const backlogTask = await findPickableBacklogTask(workspaceDir);
      if (backlogTask) {
        const lock = await acquireTaskLock(workspaceDir, backlogTask.id);
        if (!lock) {
          log.debug("Could not acquire lock for backlog task, skipping", {
            agentId,
            taskId: backlogTask.id,
          });
          return false;
        }

        try {
          const freshTask = await readTask(workspaceDir, backlogTask.id);
          if (!freshTask || freshTask.status !== "backlog") {
            log.debug("Backlog task state changed after lock, skipping", {
              agentId,
              taskId: backlogTask.id,
            });
            return false;
          }

          log.info("Found pickable backlog task, auto-picking", {
            agentId,
            taskId: freshTask.id,
            priority: freshTask.priority,
          });

          freshTask.status = "in_progress";
          freshTask.lastActivity = new Date().toISOString();
          freshTask.progress.push("Auto-picked from backlog by continuation runner");
          await writeTask(workspaceDir, freshTask);

          const prompt = formatBacklogPickupPrompt(freshTask);

          try {
            const accountId = resolveAgentBoundAccountId(
              cfg,
              agentId,
              cfg.agents?.defaults?.taskContinuation?.channel ?? "discord",
            );
            await agentCommand({
              message: prompt,
              agentId,
              accountId,
              deliver: false,
            });

            agentStates.set(agentId, {
              lastContinuationSentMs: nowMs,
              lastTaskId: freshTask.id,
              backoffUntilMs: undefined,
              consecutiveFailures: 0,
              lastFailureReason: undefined,
            });

            emit({
              type: EVENT_TYPES.BACKLOG_AUTO_PICKED,
              agentId,
              ts: Date.now(),
              data: { taskId: freshTask.id },
            });
            await updateAgentEntry(TEAM_STATE_DIR, agentId, {
              status: "active",
              currentTaskId: freshTask.id,
            });
            log.info("Backlog task picked and agent notified", {
              agentId,
              taskId: freshTask.id,
            });
            return true;
          } catch (error) {
            const latestTask = await readTask(workspaceDir, freshTask.id);

            if (!latestTask) {
              log.warn("Failed to notify agent of backlog pickup; task already removed", {
                agentId,
                taskId: freshTask.id,
                error: String(error),
              });
              return false;
            }

            if (latestTask.status !== "in_progress") {
              log.warn("Failed to notify agent of backlog pickup; task state already changed", {
                agentId,
                taskId: freshTask.id,
                latestStatus: latestTask.status,
                error: String(error),
              });
              return false;
            }

            log.warn("Failed to notify agent of backlog pickup; keeping task in_progress", {
              agentId,
              taskId: freshTask.id,
              error: String(error),
            });
            return false;
          }
        } finally {
          await lock.release();
        }
      }

      agentStates.delete(agentId);
      await updateAgentEntry(TEAM_STATE_DIR, agentId, {
        status: "idle",
        currentTaskId: null,
      });
      return false;
    }

    // Skip tasks with pending_approval status - they need human approval, not continuation
    if (activeTask.status === "pending_approval") {
      log.debug("Task is pending approval, skipping continuation", {
        agentId,
        taskId: activeTask.id,
      });
      return false;
    }

    const lastActivityMs = new Date(activeTask.lastActivity).getTime();
    const idleMs = nowMs - lastActivityMs;

    if (idleMs < idleThresholdMs) {
      log.debug("Task not idle long enough", {
        agentId,
        taskId: activeTask.id,
        idleMs,
        thresholdMs: idleThresholdMs,
      });
      return false;
    }

    const state = agentStates.get(agentId);

    // Check failure-based backoff first
    if (state?.backoffUntilMs && nowMs < state.backoffUntilMs) {
      const remainingMs = state.backoffUntilMs - nowMs;
      const remainingSec = Math.ceil(remainingMs / 1000);
      log.debug("Continuation backoff active", {
        agentId,
        taskId: activeTask.id,
        remainingSeconds: remainingSec,
        reason: state.lastFailureReason,
        consecutiveFailures: state.consecutiveFailures,
      });
      return false;
    }

    // Check regular cooldown (only for same task, prevents spam on success)
    if (state) {
      const sinceLast = nowMs - state.lastContinuationSentMs;
      if (
        sinceLast < CONTINUATION_COOLDOWN_MS &&
        state.lastTaskId === activeTask.id &&
        !state.backoffUntilMs
      ) {
        log.debug("Continuation cooldown active", {
          agentId,
          taskId: activeTask.id,
          sinceLast,
          cooldown: CONTINUATION_COOLDOWN_MS,
        });
        return false;
      }
    }

    const pendingTasks = await findPendingTasks(workspaceDir);
    const prompt = formatContinuationPrompt(activeTask, pendingTasks.length);

    log.info("Sending task continuation prompt", {
      agentId,
      taskId: activeTask.id,
      idleMinutes: Math.round(idleMs / 60000),
    });

    try {
      const accountId = resolveAgentBoundAccountId(
        cfg,
        agentId,
        cfg.agents?.defaults?.taskContinuation?.channel ?? "discord",
      );
      await agentCommand({
        message: prompt,
        agentId,
        accountId,
        deliver: false,
      });

      // Check if the agent's session hit context overflow despite agentCommand "succeeding".
      // agentCommand doesn't throw on overflow - the error is returned as a normal payload.
      // We check the session file's last message to detect this.
      const overflowCheck = await checkSessionForContextOverflow(agentId, cfg);
      if (overflowCheck.isOverflow) {
        const prevState = agentStates.get(agentId);
        const consecutiveFailures = (prevState?.consecutiveFailures ?? 0) + 1;
        const backoffMs = resolveBackoffMs("context_overflow", consecutiveFailures);
        const backoffUntilMs = nowMs + backoffMs;

        agentStates.set(agentId, {
          lastContinuationSentMs: nowMs,
          lastTaskId: activeTask.id,
          backoffUntilMs,
          consecutiveFailures,
          lastFailureReason: "context_overflow",
        });

        if (consecutiveFailures >= MAX_CONTEXT_OVERFLOW_RETRIES) {
          log.warn(
            "Agent session hit context overflow limit - attempting automatic session reset",
            {
              agentId,
              taskId: activeTask.id,
              consecutiveFailures,
            },
          );

          try {
            await callGateway({
              method: "sessions.reset",
              params: { key: `agent:${agentId}:main`, reason: "context_overflow_auto_reset" },
            });
            log.info("Auto-reset agent session after context overflow", {
              agentId,
              taskId: activeTask.id,
            });

            agentStates.set(agentId, {
              lastContinuationSentMs: nowMs,
              lastTaskId: activeTask.id,
              backoffUntilMs: nowMs + BACKOFF_MS.context_overflow,
              consecutiveFailures: 0,
              lastFailureReason: "context_overflow",
            });
          } catch (resetError) {
            log.error("Failed to auto-reset agent session after context overflow", {
              agentId,
              taskId: activeTask.id,
              error: String(resetError),
            });
          }
        } else {
          log.warn("Agent session hit context overflow after continuation prompt", {
            agentId,
            taskId: activeTask.id,
            consecutiveFailures,
            backoffSeconds: Math.round(backoffMs / 1000),
          });
        }

        emit({
          type: EVENT_TYPES.CONTINUATION_BACKOFF,
          agentId,
          ts: Date.now(),
          data: {
            taskId: activeTask.id,
            reason: "context_overflow",
            consecutiveFailures,
            backoffMs,
          },
        });
        return false;
      }

      // Success - reset failure state
      agentStates.set(agentId, {
        lastContinuationSentMs: nowMs,
        lastTaskId: activeTask.id,
        backoffUntilMs: undefined,
        consecutiveFailures: 0,
        lastFailureReason: undefined,
      });

      emit({
        type: EVENT_TYPES.CONTINUATION_SENT,
        agentId,
        ts: Date.now(),
        data: { taskId: activeTask.id },
      });
      await updateAgentEntry(TEAM_STATE_DIR, agentId, {
        status: "active",
        currentTaskId: activeTask.id,
      });
      log.info("Task continuation prompt sent", { agentId, taskId: activeTask.id });
      return true;
    } catch (error) {
      // Failure - apply backoff based on failure reason
      const { reason, suggestedBackoffMs } = parseFailureReason(error);
      const prevState = agentStates.get(agentId);
      const consecutiveFailures = (prevState?.consecutiveFailures ?? 0) + 1;
      const backoffMs = resolveBackoffMs(reason, consecutiveFailures, suggestedBackoffMs);
      const backoffUntilMs = nowMs + backoffMs;

      agentStates.set(agentId, {
        lastContinuationSentMs: nowMs,
        lastTaskId: activeTask.id,
        backoffUntilMs,
        consecutiveFailures,
        lastFailureReason: reason,
      });

      emit({
        type: EVENT_TYPES.CONTINUATION_BACKOFF,
        agentId,
        ts: Date.now(),
        data: { taskId: activeTask.id, reason, consecutiveFailures, backoffMs },
      });
      log.warn("Failed to send continuation prompt, applying backoff", {
        agentId,
        taskId: activeTask.id,
        error: String(error),
        reason,
        consecutiveFailures,
        backoffSeconds: Math.round(backoffMs / 1000),
        suggestedBackoffMs,
      });
      return false;
    }
  } finally {
    await continuationLock.release();
  }
}

/**
 * Check the agent's active session file for context overflow in the last assistant message.
 * Reads only the tail of the JSONL to avoid loading multi-MB files.
 */
async function checkSessionForContextOverflow(
  agentId: string,
  cfg: OpenClawConfig,
): Promise<{ isOverflow: boolean; messageCount?: number }> {
  try {
    const agentDir = resolveAgentDir(cfg, agentId);
    const sessionsJsonPath = path.join(agentDir, "sessions", "sessions.json");
    const sessionsJsonRaw = await fs.readFile(sessionsJsonPath, "utf8");
    const sessionsStore = JSON.parse(sessionsJsonRaw) as Record<string, { sessionId?: string }>;

    // Find the main session
    const mainKey = `agent:${agentId}:main`;
    const entry = sessionsStore[mainKey];
    if (!entry?.sessionId) {
      return { isOverflow: false };
    }

    const sessionFile = path.join(agentDir, "sessions", `${entry.sessionId}.jsonl`);

    // Read only the last 4KB of the file to find the last message
    const TAIL_BYTES = 4096;
    let fd: number;
    try {
      fd = openSync(sessionFile, "r");
    } catch {
      return { isOverflow: false };
    }
    try {
      const stat = fstatSync(fd);
      const fileSize = stat.size;
      if (fileSize === 0) {
        return { isOverflow: false };
      }

      const readStart = Math.max(0, fileSize - TAIL_BYTES);
      const readLen = fileSize - readStart;
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, readStart);
      const tail = buf.toString("utf8");

      // Find the last complete JSON line
      const lines = tail.split("\n").filter((l) => l.trim());
      if (lines.length === 0) {
        return { isOverflow: false };
      }

      const lastLine = lines[lines.length - 1];
      try {
        const msg = JSON.parse(lastLine);
        const assistantMsg = msg?.message;
        if (
          assistantMsg?.role === "assistant" &&
          assistantMsg?.stopReason === "error" &&
          assistantMsg?.errorMessage &&
          /context.*overflow|context.length.exceeded|token.*limit|too long|max.*token|prompt is too long|exceeds.*context/i.test(
            assistantMsg.errorMessage,
          )
        ) {
          return { isOverflow: true, messageCount: undefined };
        }
      } catch {
        // Parse error on last line - not an overflow indicator
      }
    } finally {
      closeSync(fd);
    }
    return { isOverflow: false };
  } catch {
    // Any error reading session - don't block continuation
    return { isOverflow: false };
  }
}

const BLOCKED_RESUME_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes (reduced from 10 for faster resume checks)
const blockedResumeLastSentMs = new Map<string, number>();

function formatBlockedResumeReminderPrompt(task: TaskFile): string {
  const lines = [
    `[SYSTEM REMINDER - BLOCKED TASK RESUME CHECK]`,
    ``,
    `You have a blocked task that may already be resolved:`,
    ``,
    `**Task ID:** ${task.id}`,
    `**Description:** ${task.description}`,
    `**Blocked Reason:** ${task.blockedReason || "No reason provided"}`,
  ];

  if (task.unblockedBy && task.unblockedBy.length > 0) {
    lines.push(`**Unblock requested from:** ${task.unblockedBy.join(", ")}`);
  }

  lines.push(``);
  lines.push(
    `An unblock request was already sent to the agents listed above. The blocking condition may have been resolved.`,
  );
  lines.push(``);
  lines.push(`**YOU MUST DO THE FOLLOWING:**`);
  lines.push(
    `1. Check if the blocking condition has been resolved (review recent messages, check if required work was completed).`,
  );
  lines.push(
    `2. If the blocker IS resolved → Call task_resume(task_id="${task.id}") IMMEDIATELY to continue working.`,
  );
  lines.push(
    `3. If the blocker is NOT resolved → Do nothing. The system will check again in 3 minutes.`,
  );
  lines.push(``);
  lines.push(
    `**Do NOT wait passively.** Actively verify the blocker status and resume if possible.`,
  );

  return lines.join("\n");
}

async function checkBlockedTasksForResume(
  cfg: OpenClawConfig,
  agentId: string,
  nowMs: number,
): Promise<void> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const blockedTasks = await findBlockedTasks(workspaceDir);

  // Check agent-specific queue
  const agentLane = `session:agent:${agentId}:main`;
  if (isAgentActivelyProcessing(agentLane)) {
    return; // Agent busy
  }

  for (const task of blockedTasks) {
    // Only remind for tasks where unblock requests have been sent
    if (!task.unblockRequestCount || task.unblockRequestCount < 1) {
      continue;
    }

    // Skip if escalation already failed
    if (task.escalationState === "failed") {
      continue;
    }

    // Cooldown check
    const resumeKey = `${agentId}:${task.id}`;
    const lastSent = blockedResumeLastSentMs.get(resumeKey) ?? 0;
    if (nowMs - lastSent < BLOCKED_RESUME_COOLDOWN_MS) {
      continue;
    }

    const lock = await acquireTaskLock(workspaceDir, task.id);
    if (!lock) {
      continue;
    }

    try {
      const freshTask = await readTask(workspaceDir, task.id);
      if (!freshTask || freshTask.status !== "blocked") {
        continue;
      }

      const prompt = formatBlockedResumeReminderPrompt(freshTask);

      log.info("Sending blocked task resume reminder to blocked agent", {
        agentId,
        taskId: freshTask.id,
        unblockRequestCount: freshTask.unblockRequestCount,
      });

      // Fix #6: Set cooldown BEFORE sending to prevent duplicate sends during async gap
      blockedResumeLastSentMs.set(resumeKey, nowMs);

      try {
        const accountId = resolveAgentBoundAccountId(
          cfg,
          agentId,
          cfg.agents?.defaults?.taskContinuation?.channel ?? "discord",
        );
        await agentCommand({
          message: prompt,
          agentId,
          accountId,
          deliver: false,
        });

        log.info("Blocked task resume reminder sent", {
          agentId,
          taskId: freshTask.id,
        });
      } catch (error) {
        // Revert cooldown on failure so retry can happen on next cycle
        blockedResumeLastSentMs.delete(resumeKey);

        log.warn("Failed to send blocked task resume reminder", {
          agentId,
          taskId: freshTask.id,
          error: String(error),
        });
      }
    } finally {
      await lock.release();
    }
  }
}

async function checkBlockedTasksForUnblock(
  cfg: OpenClawConfig,
  agentId: string,
  nowMs: number,
): Promise<void> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const blockedTasks = await findBlockedTasks(workspaceDir);
  const a2aPolicy = createAgentToAgentPolicy(cfg);

  for (const task of blockedTasks) {
    // Try to acquire lock for this task
    const lock = await acquireTaskLock(workspaceDir, task.id);
    if (!lock) {
      log.debug("Could not acquire lock for task, skipping", { taskId: task.id });
      continue;
    }

    try {
      // Re-read task after lock to verify state (race condition fix)
      const freshTask = await readTask(workspaceDir, task.id);
      if (!freshTask || freshTask.status !== "blocked") {
        log.debug("Task state changed after lock acquired, skipping", {
          taskId: task.id,
          newStatus: freshTask?.status ?? "deleted",
        });
        continue;
      }

      if (!freshTask.unblockedBy || freshTask.unblockedBy.length === 0) {
        continue;
      }

      const requestCount = freshTask.unblockRequestCount ?? 0;

      // Set escalationState to 'requesting' on first request
      if (
        requestCount === 0 ||
        freshTask.escalationState === undefined ||
        freshTask.escalationState === "none"
      ) {
        freshTask.escalationState = "requesting";
      }
      if (requestCount >= MAX_UNBLOCK_REQUESTS) {
        log.debug("Max unblock requests reached", {
          blockedAgentId: agentId,
          taskId: freshTask.id,
          requestCount,
        });
        freshTask.escalationState = "failed";
        await writeTask(workspaceDir, freshTask);
        continue;
      }

      const lastRequestAt = freshTask.lastUnblockRequestAt;
      if (lastRequestAt) {
        const lastRequestMs = new Date(lastRequestAt).getTime();
        if (!isNaN(lastRequestMs) && nowMs - lastRequestMs < UNBLOCK_COOLDOWN_MS) {
          log.debug("Unblock cooldown active", {
            blockedAgentId: agentId,
            taskId: freshTask.id,
            sinceLast: nowMs - lastRequestMs,
            cooldown: UNBLOCK_COOLDOWN_MS,
          });
          continue;
        }
      }

      // Rotation logic - cycle through unblockedBy array
      const lastIndex = freshTask.lastUnblockerIndex ?? -1;
      const clampedLastIndex = Math.max(-1, Math.min(lastIndex, freshTask.unblockedBy.length - 1));
      const nextIndex = (clampedLastIndex + 1) % freshTask.unblockedBy.length;
      const targetAgentId = freshTask.unblockedBy[nextIndex];
      freshTask.lastUnblockerIndex = nextIndex;

      // Check A2A policy before sending request
      if (!a2aPolicy.isAllowed(agentId, targetAgentId)) {
        log.debug("A2A policy denied unblock request", {
          blockedAgentId: agentId,
          targetAgentId,
          taskId: freshTask.id,
        });

        // Check if all unblockers are denied by policy
        const allDenied = freshTask.unblockedBy.every(
          (unblocker) => !a2aPolicy.isAllowed(agentId, unblocker),
        );

        if (allDenied) {
          freshTask.escalationState = "failed";
        }

        await writeTask(workspaceDir, freshTask);
        continue;
      }

      const prompt = formatUnblockRequestPrompt(agentId, freshTask);

      log.info("Sending unblock request", {
        blockedAgentId: agentId,
        targetAgentId,
        taskId: freshTask.id,
        requestCount: requestCount + 1,
      });

      try {
        const isLastAttempt = requestCount + 1 >= MAX_UNBLOCK_REQUESTS;
        const escalationPrompt = isLastAttempt
          ? formatUnblockEscalationPrompt(agentId, freshTask, targetAgentId)
          : prompt;

        const accountId = resolveAgentBoundAccountId(
          cfg,
          targetAgentId,
          cfg.agents?.defaults?.taskContinuation?.channel ?? "discord",
        );
        await agentCommand({
          message: escalationPrompt,
          agentId: targetAgentId,
          accountId,
          deliver: isLastAttempt,
        });

        freshTask.lastUnblockRequestAt = new Date(nowMs).toISOString();
        freshTask.unblockRequestCount = requestCount + 1;
        freshTask.lastActivity = new Date().toISOString();
        // Keep escalationState as 'requesting' for subsequent attempts
        if (freshTask.escalationState !== "requesting") {
          freshTask.escalationState = "requesting";
        }
        const escalationTag = isLastAttempt ? " [ESCALATED TO DISCORD]" : "";
        freshTask.progress.push(
          `[UNBLOCK REQUEST ${freshTask.unblockRequestCount}/${MAX_UNBLOCK_REQUESTS}] Sent to ${targetAgentId}${escalationTag}`,
        );
        freshTask.unblockRequestFailures = 0;
        await writeTask(workspaceDir, freshTask);

        emit({
          type: EVENT_TYPES.UNBLOCK_REQUESTED,
          agentId,
          ts: Date.now(),
          data: {
            taskId: freshTask.id,
            targetAgentId,
            requestCount: freshTask.unblockRequestCount,
          },
        });
        log.info("Unblock request sent", {
          blockedAgentId: agentId,
          targetAgentId,
          taskId: freshTask.id,
          requestCount: freshTask.unblockRequestCount,
        });
      } catch (error) {
        // Track consecutive failures
        freshTask.unblockRequestFailures = (freshTask.unblockRequestFailures ?? 0) + 1;

        if (freshTask.unblockRequestFailures >= MAX_UNBLOCK_FAILURES) {
          freshTask.escalationState = "failed";
          log.warn("Max unblock request failures reached, marking escalation as failed", {
            blockedAgentId: agentId,
            taskId: freshTask.id,
            failures: freshTask.unblockRequestFailures,
          });
        }

        await writeTask(workspaceDir, freshTask);

        log.warn("Failed to send unblock request", {
          blockedAgentId: agentId,
          targetAgentId,
          taskId: freshTask.id,
          error: String(error),
          consecutiveFailures: freshTask.unblockRequestFailures,
        });
      }
    } catch (error) {
      log.error("Failed to process blocked task", {
        taskId: task.id,
        error: String(error),
      });
    } finally {
      await lock.release();
    }
  }
}

async function checkZombieTasksForAbandonment(
  cfg: OpenClawConfig,
  zombieTaskTtlMs: number,
): Promise<void> {
  const nowMs = Date.now();
  const agentList = cfg.agents?.list ?? [];
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const agentIds = new Set<string>();
  agentIds.add(normalizeAgentId(defaultAgentId));
  for (const entry of agentList) {
    if (entry?.id) {
      agentIds.add(normalizeAgentId(entry.id));
    }
  }
  for (const agentId of agentIds) {
    try {
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const tasksDir = path.join(workspaceDir, "tasks");
      let files: string[];
      try {
        files = await fs.readdir(tasksDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.startsWith("task_") || !file.endsWith(".md")) {
          continue;
        }
        const taskId = file.replace(".md", "");
        const task = await readTask(workspaceDir, taskId);
        if (!task || task.status !== "in_progress") {
          continue;
        }
        const lastActivityMs = new Date(task.lastActivity || task.created).getTime();
        if (isNaN(lastActivityMs)) {
          continue;
        }
        const ageMs = nowMs - lastActivityMs;
        if (ageMs > zombieTaskTtlMs) {
          const lock = await acquireTaskLock(workspaceDir, task.id);
          if (!lock) {
            continue;
          }
          try {
            const freshTask = await readTask(workspaceDir, task.id);
            if (!freshTask || freshTask.status !== "in_progress") {
              continue;
            }
            // Fix #4: Re-check lastActivity freshness after lock acquisition
            const freshActivityMs = new Date(freshTask.lastActivity || freshTask.created).getTime();
            if (!isNaN(freshActivityMs)) {
              const freshAgeMs = Date.now() - freshActivityMs;
              if (freshAgeMs <= zombieTaskTtlMs) {
                log.debug("Task activity updated after lock, no longer zombie", {
                  agentId,
                  taskId: task.id,
                  freshAgeMs,
                });
                continue;
              }
            }
            const reassignCount = (freshTask.reassignCount ?? 0) + 1;
            freshTask.reassignCount = reassignCount;
            freshTask.lastActivity = new Date().toISOString();

            if (reassignCount < 3) {
              // Auto-recover: move to backlog for re-pickup
              freshTask.status = "backlog";
              freshTask.outcome = undefined;
              freshTask.progress.push(
                `Auto-recovered to backlog after zombie detection (reassign #${reassignCount}/3)`,
              );
              await writeTask(workspaceDir, freshTask);
              await updateAgentEntry(TEAM_STATE_DIR, agentId, {
                status: "idle",
                currentTaskId: null,
              });
              emit({
                type: EVENT_TYPES.ZOMBIE_ABANDONED,
                agentId,
                ts: Date.now(),
                data: {
                  taskId: task.id,
                  ageHours: Math.round(ageMs / 3600000),
                  reassignCount,
                  action: "moved_to_backlog",
                },
              });
              log.info("Zombie task auto-recovered to backlog", {
                agentId,
                taskId: task.id,
                ageHours: Math.round(ageMs / 3600000),
                reassignCount,
              });
            } else {
              // Exceeded reassign limit — keep interrupted, notify lead agent
              freshTask.status = "interrupted";
              freshTask.outcome = {
                kind: "interrupted",
                reason: `Reassigned ${reassignCount} times — escalating. No activity for ${Math.round(ageMs / 3600000)}h`,
              };
              freshTask.progress.push(
                `Kept interrupted: exceeded reassign limit of 3 (inactive ${Math.round(ageMs / 3600000)}h)`,
              );
              await writeTask(workspaceDir, freshTask);
              await updateAgentEntry(TEAM_STATE_DIR, agentId, {
                status: "interrupted",
                currentTaskId: null,
                lastFailureReason: "zombie_timeout_escalated",
              });
              emit({
                type: EVENT_TYPES.ZOMBIE_ABANDONED,
                agentId,
                ts: Date.now(),
                data: {
                  taskId: task.id,
                  ageHours: Math.round(ageMs / 3600000),
                  reassignCount,
                  action: "escalated",
                },
              });
              log.info("Zombie task escalated (reassign limit exceeded)", {
                agentId,
                taskId: task.id,
                ageHours: Math.round(ageMs / 3600000),
                reassignCount,
              });
              // Notify lead agent about the escalated task
              try {
                const teamState = await readTeamState(TEAM_STATE_DIR);
                const lead = findLeadAgent(teamState);
                if (lead && lead.agentId !== agentId) {
                  const leadAccountId = resolveAgentBoundAccountId(
                    cfg,
                    lead.agentId,
                    cfg.agents?.defaults?.taskContinuation?.channel ?? "discord",
                  );
                  await agentCommand({
                    message: [
                      `[SYSTEM - ZOMBIE TASK ESCALATED]`,
                      ``,
                      `Agent "${agentId}" had a task interrupted after ${reassignCount} reassign attempts.`,
                      `**Task ID:** ${freshTask.id}`,
                      `**Description:** ${freshTask.description}`,
                      `**Inactive for:** ${Math.round(ageMs / 3600000)}h`,
                      ``,
                      `The task has exceeded the auto-recovery limit and needs manual attention.`,
                      `Consider investigating why the agent keeps abandoning this task.`,
                    ].join("\n"),
                    agentId: lead.agentId,
                    accountId: leadAccountId,
                    deliver: false,
                  });
                  log.info("Lead agent notified about escalated zombie task", {
                    leadAgentId: lead.agentId,
                    interruptedAgentId: agentId,
                    taskId: freshTask.id,
                  });
                }
              } catch (notifyError) {
                log.warn("Failed to notify lead agent about escalated task", {
                  agentId,
                  taskId: freshTask.id,
                  error: String(notifyError),
                });
              }
            }
          } finally {
            await lock.release();
          }
        }
      }
    } catch (error) {
      log.warn("Error checking zombie tasks", { agentId, error: String(error) });
    }
  }
}
async function runContinuationCheck(cfg: OpenClawConfig, idleThresholdMs: number): Promise<void> {
  const { zombieTaskTtlMs } = resolveTaskContinuationConfig(cfg);
  await checkZombieTasksForAbandonment(cfg, zombieTaskTtlMs);

  const nowMs = Date.now();
  const agentList = cfg.agents?.list ?? [];
  const defaultAgentId = resolveDefaultAgentId(cfg);

  const agentIds = new Set<string>();
  agentIds.add(normalizeAgentId(defaultAgentId));
  for (const entry of agentList) {
    if (entry?.id) {
      agentIds.add(normalizeAgentId(entry.id));
    }
  }

  log.debug("Running task continuation check", { agentCount: agentIds.size });

  for (const agentId of agentIds) {
    try {
      await checkAgentForContinuation(cfg, agentId, idleThresholdMs, nowMs);
    } catch (error) {
      // Fix #5: Isolate failures per check type to prevent one agent's error from blocking others
      log.warn("Error in continuation check", { agentId, error: String(error) });
    }
    try {
      await checkBlockedTasksForUnblock(cfg, agentId, nowMs);
    } catch (error) {
      log.warn("Error in unblock check", { agentId, error: String(error) });
    }
    try {
      await checkBlockedTasksForResume(cfg, agentId, nowMs);
    } catch (error) {
      log.warn("Error in resume check", { agentId, error: String(error) });
    }
  }
}

export function startTaskContinuationRunner(opts: { cfg: OpenClawConfig }): TaskContinuationRunner {
  let currentCfg = opts.cfg;
  let timer: NodeJS.Timeout | null = null;
  let cleanupTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) {
      return;
    }

    const { enabled, checkIntervalMs, idleThresholdMs } = resolveTaskContinuationConfig(currentCfg);

    if (!enabled) {
      log.debug("Task continuation runner disabled");
      return;
    }

    timer = setTimeout(async () => {
      if (stopped) {
        return;
      }

      try {
        await runContinuationCheck(currentCfg, idleThresholdMs);
      } catch (error) {
        log.warn("Task continuation check failed", { error: String(error) });
      }

      scheduleNext();
    }, checkIntervalMs);

    timer.unref?.();
  };

  const { enabled } = resolveTaskContinuationConfig(currentCfg);
  if (enabled) {
    log.info("Task continuation runner started");
    scheduleNext();
    cleanupTimer = setInterval(cleanupStaleAgentStates, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
  }

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      agentStates.clear();
      log.info("Task continuation runner stopped");
    },

    updateConfig: (cfg: OpenClawConfig) => {
      currentCfg = cfg;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!stopped) {
        scheduleNext();
      }
    },

    checkNow: async () => {
      const { idleThresholdMs } = resolveTaskContinuationConfig(currentCfg);
      await runContinuationCheck(currentCfg, idleThresholdMs);
    },
  };
}
