/**
 * Daily Review Reminder System
 *
 * Sends reminders to review and update daily memory logs.
 */

import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { formatDate } from "./daily-memory.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("memory-hybrid-review");

export const DEFAULT_DAILY_REVIEW_TIME = "22:00";
export const DEFAULT_DAILY_REVIEW_MESSAGE = `🌙 **Daily Review Time**

Take a moment to review today's conversations and add key insights to your daily log:

Check \`memory/{{date}}.md\` and add:
- Important decisions made
- New things learned
- Action items to remember
- Links and references

This helps build your long-term memory and makes future conversations more context-aware.`;

/**
 * Resolve daily review configuration with defaults
 */
export function resolveDailyReviewConfig(cfg: OpenClawConfig): {
  enabled: boolean;
  at: string;
  message: string;
  channelId?: string;
} {
  const config = cfg.memory?.hybrid?.dailyReview;
  return {
    enabled: config?.enabled ?? false,
    at: config?.at ?? DEFAULT_DAILY_REVIEW_TIME,
    message: config?.message ?? DEFAULT_DAILY_REVIEW_MESSAGE,
    channelId: config?.channelId,
  };
}

/**
 * Render daily review message with date
 */
export function renderDailyReviewMessage(
  template: string,
  date: Date,
): string {
  const dateStr = formatDate(date);
  return template.replace(/\{\{date\}\}/g, dateStr);
}

/**
 * Check if daily review is enabled
 */
export function isDailyReviewEnabled(cfg: OpenClawConfig): boolean {
  const dailyReview = resolveDailyReviewConfig(cfg);
  return dailyReview.enabled;
}

/**
 * Generate daily review reminder
 */
export function generateDailyReviewReminder(
  cfg: OpenClawConfig,
  agentId: string,
  date: Date = new Date(),
): {
  message: string;
  dailyLogPath: string;
  date: string;
} | null {
  if (!isDailyReviewEnabled(cfg)) {
    return null;
  }

  const dailyReview = resolveDailyReviewConfig(cfg);
  const message = renderDailyReviewMessage(dailyReview.message, date);
  const dateStr = formatDate(date);

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const dailyLogPath = `${workspaceDir}/memory/${dateStr}.md`;

  return {
    message,
    dailyLogPath,
    date: dateStr,
  };
}

/**
 * Log daily review reminder (for notification delivery)
 */
export function logDailyReviewReminder(
  cfg: OpenClawConfig,
  agentId: string,
  date: Date = new Date(),
): void {
  const reminder = generateDailyReviewReminder(cfg, agentId, date);
  if (!reminder) {
    return;
  }

  log.info(
    `Daily review reminder for ${reminder.date}:\n${reminder.message}`,
  );
}

/**
 * Format daily review reminder for channel delivery
 */
export function formatDailyReviewForChannel(
  cfg: OpenClawConfig,
  agentId: string,
  date: Date = new Date(),
): { text: string } | null {
  const reminder = generateDailyReviewReminder(cfg, agentId, date);
  if (!reminder) {
    return null;
  }

  return {
    text: reminder.message,
  };
}

/**
 * Get cron schedule for daily review
 */
export function getDailyReviewCronSchedule(cfg: OpenClawConfig): string | null {
  if (!isDailyReviewEnabled(cfg)) {
    return null;
  }

  const dailyReview = resolveDailyReviewConfig(cfg);
  const match = dailyReview.at.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    log.warn(`Invalid daily review time format: ${dailyReview.at}`);
    return null;
  }

  const hour = match[1]!;
  const minute = match[2]!;

  return `${minute} ${hour} * * *`;
}
