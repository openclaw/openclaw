/**
 * Memory Hybrid Mode
 *
 * Auto-creates daily log templates while keeping manual control over content.
 */

// Daily memory management
export {
  DEFAULT_DAILY_LOG_TEMPLATE,
  DEFAULT_CREATE_AT,
  DEFAULT_CREATE_DAYS_AHEAD,
  formatDate,
  parseTimeToMinutes,
  shouldCreateNextDay,
  getTargetDate,
  renderTemplate,
  getDailyLogPath,
  dailyLogExists,
  ensureMemoryDir,
  createDailyLogTemplate,
  createUpcomingDailyLogs,
  resolveDailyLogConfig,
  isHybridModeEnabled,
  initializeDailyMemory,
  createNextDailyLog,
} from "./daily-memory.js";

// Daily review reminders
export {
  DEFAULT_DAILY_REVIEW_TIME,
  DEFAULT_DAILY_REVIEW_MESSAGE,
  resolveDailyReviewConfig,
  renderDailyReviewMessage,
  isDailyReviewEnabled,
  generateDailyReviewReminder,
  logDailyReviewReminder,
  formatDailyReviewForChannel,
  getDailyReviewCronSchedule,
} from "./daily-review.js";

// Session-end prompting
export {
  DEFAULT_MIN_SESSION_MINUTES,
  DEFAULT_SESSION_END_MESSAGE,
  resolveSessionEndPromptConfig,
  isSessionEndPromptEnabled,
  shouldPromptForMemory,
  generateSessionEndPrompt,
  formatSessionEndPromptForUser,
  isAutoSaveRequest,
  isSkipRequest,
} from "./session-end-prompt.js";
