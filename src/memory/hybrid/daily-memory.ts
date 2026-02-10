/**
 * Daily Memory Management
 *
 * Auto-creates daily log templates in hybrid mode.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("memory-hybrid");

export const DEFAULT_DAILY_LOG_TEMPLATE = `# {{date}} - Daily Log

## Morning Notes

## Afternoon Progress

## Evening Reflection

## Key Learnings

## Action Items

## Links & References
`;

export const DEFAULT_CREATE_AT = "22:00";
export const DEFAULT_CREATE_DAYS_AHEAD = 1;

/**
 * Format date as YYYY-MM-DD
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parse time string (HH:MM) and return minutes from midnight
 */
export function parseTimeToMinutes(timeStr: string): number {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid time format: ${timeStr}. Expected HH:MM`);
  }
  const hours = parseInt(match[1]!, 10);
  const minutes = parseInt(match[2]!, 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid time: ${timeStr}`);
  }
  return hours * 60 + minutes;
}

/**
 * Check if it's time to create the next day's template
 */
export function shouldCreateNextDay(
  currentTime: Date,
  createTimeStr: string,
): boolean {
  const createMinutes = parseTimeToMinutes(createTimeStr);
  const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
  return currentMinutes >= createMinutes;
}

/**
 * Get the target date for template creation
 */
export function getTargetDate(
  baseDate: Date,
  daysAhead: number,
): Date {
  const target = new Date(baseDate);
  target.setDate(target.getDate() + daysAhead);
  target.setHours(0, 0, 0, 0);
  return target;
}

/**
 * Render template with date placeholder
 */
export function renderTemplate(template: string, date: Date): string {
  const dateStr = formatDate(date);
  return template.replace(/\{\{date\}\}/g, dateStr);
}

/**
 * Get daily log file path for a given date
 */
export function getDailyLogPath(workspaceDir: string, date: Date): string {
  const dateStr = formatDate(date);
  return path.join(workspaceDir, "memory", `${dateStr}.md`);
}

/**
 * Check if daily log file exists
 */
export async function dailyLogExists(
  workspaceDir: string,
  date: Date,
): Promise<boolean> {
  const filePath = getDailyLogPath(workspaceDir, date);
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure memory directory exists
 */
export async function ensureMemoryDir(workspaceDir: string): Promise<void> {
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
}

/**
 * Create daily log template file
 */
export async function createDailyLogTemplate(
  workspaceDir: string,
  date: Date,
  template: string,
): Promise<{ created: boolean; path: string }> {
  const filePath = getDailyLogPath(workspaceDir, date);
  const rendered = renderTemplate(template, date);

  try {
    await fs.access(filePath);
    log.debug(`Daily log already exists: ${filePath}`);
    return { created: false, path: filePath };
  } catch {
    await ensureMemoryDir(workspaceDir);
    await fs.writeFile(filePath, rendered, "utf-8");
    log.info(`Created daily log template: ${filePath}`);
    return { created: true, path: filePath };
  }
}

/**
 * Create daily log templates for upcoming days
 */
export async function createUpcomingDailyLogs(
  workspaceDir: string,
  template: string,
  daysAhead: number,
  baseDate: Date = new Date(),
): Promise<{ created: number; paths: string[] }> {
  const results: string[] = [];
  let createdCount = 0;

  for (let i = 1; i <= daysAhead; i++) {
    const targetDate = getTargetDate(baseDate, i);
    const result = await createDailyLogTemplate(workspaceDir, targetDate, template);
    if (result.created) {
      createdCount++;
    }
    results.push(result.path);
  }

  return { created: createdCount, paths: results };
}

/**
 * Resolve hybrid daily log configuration with defaults
 */
export function resolveDailyLogConfig(cfg: OpenClawConfig): {
  enabled: boolean;
  template: string;
  createDaysAhead: number;
  createAt: string;
} {
  const config = cfg.memory?.hybrid?.dailyLog;
  return {
    enabled: config?.enabled ?? false,
    template: config?.template ?? DEFAULT_DAILY_LOG_TEMPLATE,
    createDaysAhead: config?.createDaysAhead ?? DEFAULT_CREATE_DAYS_AHEAD,
    createAt: config?.createAt ?? DEFAULT_CREATE_AT,
  };
}

/**
 * Check if hybrid mode is enabled
 */
export function isHybridModeEnabled(cfg: OpenClawConfig): boolean {
  const mode = cfg.memory?.mode ?? "manual";
  const hybridEnabled = cfg.memory?.hybrid?.enabled ?? false;
  return mode === "hybrid" || hybridEnabled;
}

/**
 * Initialize daily memory for an agent
 */
export async function initializeDailyMemory(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<void> {
  if (!isHybridModeEnabled(cfg)) {
    return;
  }

  const dailyLogConfig = resolveDailyLogConfig(cfg);
  if (!dailyLogConfig.enabled) {
    return;
  }

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const today = new Date();

  await createDailyLogTemplate(
    workspaceDir,
    today,
    dailyLogConfig.template,
  );

  await createUpcomingDailyLogs(
    workspaceDir,
    dailyLogConfig.template,
    dailyLogConfig.createDaysAhead,
    today,
  );

  log.info(
    `Daily memory initialized for agent ${agentId}: ` +
      `today + ${dailyLogConfig.createDaysAhead} days ahead`,
  );
}

/**
 * Create next day's daily log (for cron job)
 */
export async function createNextDailyLog(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<{ created: boolean; path: string } | null> {
  if (!isHybridModeEnabled(cfg)) {
    return null;
  }

  const dailyLogConfig = resolveDailyLogConfig(cfg);
  if (!dailyLogConfig.enabled) {
    return null;
  }

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const tomorrow = getTargetDate(new Date(), 1);

  return createDailyLogTemplate(
    workspaceDir,
    tomorrow,
    dailyLogConfig.template,
  );
}
