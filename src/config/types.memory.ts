import type { SessionSendPolicyConfig } from "./types.base.js";

export type MemoryBackend = "builtin" | "qmd";
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryMode = "manual" | "hybrid";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  mode?: MemoryMode;
  hybrid?: MemoryHybridConfig;
  qmd?: MemoryQmdConfig;
};

export type MemoryQmdConfig = {
  command?: string;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

export type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type MemoryQmdUpdateConfig = {
  interval?: string;
  debounceMs?: number;
  onBoot?: boolean;
  waitForBootSync?: boolean;
  embedInterval?: string;
  commandTimeoutMs?: number;
  updateTimeoutMs?: number;
  embedTimeoutMs?: number;
};

export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};

/**
 * Configuration for hybrid memory mode
 * Automatically creates daily log templates while keeping manual control over content
 */
export type MemoryHybridConfig = {
  /**
   * Enable hybrid mode features
   * @default false
   */
  enabled?: boolean;

  /**
   * Daily log template auto-creation
   */
  dailyLog?: MemoryHybridDailyLogConfig;

  /**
   * Daily review reminder system
   */
  dailyReview?: MemoryHybridDailyReviewConfig;

  /**
   * Session-end memory prompting
   */
  sessionEnd?: MemoryHybridSessionEndConfig;
};

export type MemoryHybridDailyLogConfig = {
  /**
   * Enable auto-creation of daily log templates
   * @default false
   */
  enabled?: boolean;

  /**
   * Custom template for daily log (markdown format)
   * Use {{date}} placeholder for the date
   */
  template?: string;

  /**
   * Create templates N days in advance
   * @default 1
   */
  createDaysAhead?: number;

  /**
   * Time of day to create next day's template (HH:MM format)
   * @default "22:00"
   */
  createAt?: string;
};

export type MemoryHybridDailyReviewConfig = {
  /**
   * Enable daily review reminder
   * @default false
   */
  enabled?: boolean;

  /**
   * Time of day to send reminder (HH:MM format)
   * @default "22:00"
   */
  at?: string;

  /**
   * Reminder message template
   * Use {{date}} placeholder for the date
   */
  message?: string;

  /**
   * Channel ID to send reminder to (optional, for DM reminders)
   */
  channelId?: string;
};

export type MemoryHybridSessionEndConfig = {
  /**
   * Prompt user to save to memory after meaningful sessions
   * @default false
   */
  prompt?: boolean;

  /**
   * Minimum session duration (minutes) to trigger prompt
   * @default 5
   */
  minDurationMinutes?: number;

  /**
   * Prompt message template
   */
  message?: string;
};
