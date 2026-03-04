/**
 * Pre-built cron job templates for OpenClaw
 * 
 * Common cron job patterns to speed up job creation:
 * - Daily backups
 * - Hourly health checks
 * - Weekly reports
 * - Website monitoring
 * - News/feed scraping
 */

import type { CronFormState } from "./ui-types.ts";

export type CronTemplate = {
  id: string;
  name: string;
  description: string;
  category: "backup" | "monitoring" | "reporting" | "scraping" | "maintenance";
  icon: string;
  formState: Partial<CronFormState>;
};

export const CRON_TEMPLATES: CronTemplate[] = [
  // Backup templates
  {
    id: "daily-backup-3am",
    name: "Daily Backup (3 AM)",
    description: "Run a backup job every day at 3:00 AM",
    category: "backup",
    icon: "💾",
    formState: {
      name: "Daily Backup",
      schedule: "0 3 * * *",
      timezone: "America/Los_Angeles",
      enabled: true,
      prompt: "Create a backup of all important data and configurations",
      thinking: "low",
      deliveryMode: "last",
    },
  },
  {
    id: "weekly-backup-sunday",
    name: "Weekly Backup (Sunday)",
    description: "Run a backup job every Sunday at 2:00 AM",
    category: "backup",
    icon: "💾",
    formState: {
      name: "Weekly Backup",
      schedule: "0 2 * * 0",
      timezone: "America/Los_Angeles",
      enabled: true,
      prompt: "Create a comprehensive weekly backup of all systems",
      thinking: "low",
      deliveryMode: "last",
    },
  },

  // Monitoring templates
  {
    id: "hourly-health-check",
    name: "Hourly Health Check",
    description: "Check system health every hour",
    category: "monitoring",
    icon: "❤️",
    formState: {
      name: "Hourly Health Check",
      schedule: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      prompt:
        "Check system health: gateway status, memory usage, active sessions, and error rate. Report any issues.",
      thinking: "minimal",
      deliveryMode: "last",
    },
  },
  {
    id: "website-uptime-5min",
    name: "Website Uptime Monitor (5 min)",
    description: "Check if a website is up every 5 minutes",
    category: "monitoring",
    icon: "🌐",
    formState: {
      name: "Website Uptime Monitor",
      schedule: "*/5 * * * *",
      timezone: "UTC",
      enabled: true,
      prompt:
        "Check if https://example.com is accessible. If down, alert immediately with status code and error details.",
      thinking: "minimal",
      deliveryMode: "last",
    },
  },
  {
    id: "disk-space-check-daily",
    name: "Daily Disk Space Check",
    description: "Monitor disk space usage every day at 9 AM",
    category: "monitoring",
    icon: "💽",
    formState: {
      name: "Disk Space Check",
      schedule: "0 9 * * *",
      timezone: "America/Los_Angeles",
      enabled: true,
      prompt:
        "Check disk space usage. Alert if any volume is over 80% full. Include current usage and recommendations.",
      thinking: "low",
      deliveryMode: "last",
    },
  },

  // Reporting templates
  {
    id: "weekly-report-monday",
    name: "Weekly Report (Monday 9 AM)",
    description: "Generate a weekly summary report every Monday",
    category: "reporting",
    icon: "📊",
    formState: {
      name: "Weekly Report",
      schedule: "0 9 * * 1",
      timezone: "America/Los_Angeles",
      enabled: true,
      prompt:
        "Generate a weekly report: message volume, top agents used, error summary, model usage, and notable events from the past week.",
      thinking: "medium",
      deliveryMode: "last",
    },
  },
  {
    id: "monthly-summary",
    name: "Monthly Summary (1st of month)",
    description: "Generate monthly summary on the first day of each month",
    category: "reporting",
    icon: "📈",
    formState: {
      name: "Monthly Summary",
      schedule: "0 10 1 * *",
      timezone: "America/Los_Angeles",
      enabled: true,
      prompt:
        "Generate a comprehensive monthly report: usage statistics, cost summary, top features, system health trends, and recommendations for next month.",
      thinking: "high",
      deliveryMode: "last",
    },
  },
  {
    id: "daily-digest-evening",
    name: "Daily Digest (6 PM)",
    description: "Send a daily summary every evening",
    category: "reporting",
    icon: "📰",
    formState: {
      name: "Daily Digest",
      schedule: "0 18 * * *",
      timezone: "America/Los_Angeles",
      enabled: true,
      prompt:
        "Create a daily digest: today's message count, active channels, any errors or warnings, and system status.",
      thinking: "low",
      deliveryMode: "last",
    },
  },

  // Scraping/data collection templates
  {
    id: "news-feed-15min",
    name: "News Feed Monitor (15 min)",
    description: "Check news feeds every 15 minutes for new articles",
    category: "scraping",
    icon: "📡",
    formState: {
      name: "News Feed Monitor",
      schedule: "*/15 * * * *",
      timezone: "UTC",
      enabled: true,
      prompt:
        "Check RSS feeds for new articles. Summarize any breaking news or important updates. Sources: [add your RSS URLs here]",
      thinking: "medium",
      deliveryMode: "last",
    },
  },
  {
    id: "price-tracker-hourly",
    name: "Price Tracker (Hourly)",
    description: "Track product prices every hour",
    category: "scraping",
    icon: "💰",
    formState: {
      name: "Price Tracker",
      schedule: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      prompt:
        "Check prices for tracked products: [add product URLs]. Alert if any price drops below target or changes significantly.",
      thinking: "low",
      deliveryMode: "last",
    },
  },
  {
    id: "social-media-mentions",
    name: "Social Media Mentions (30 min)",
    description: "Monitor social media for mentions every 30 minutes",
    category: "scraping",
    icon: "📱",
    formState: {
      name: "Social Media Mentions",
      schedule: "*/30 * * * *",
      timezone: "UTC",
      enabled: true,
      prompt:
        "Check social media for mentions of [your brand/keywords]. Summarize new mentions and sentiment.",
      thinking: "medium",
      deliveryMode: "last",
    },
  },

  // Maintenance templates
  {
    id: "cleanup-logs-weekly",
    name: "Weekly Log Cleanup",
    description: "Clean up old logs every Sunday at midnight",
    category: "maintenance",
    icon: "🧹",
    formState: {
      name: "Log Cleanup",
      schedule: "0 0 * * 0",
      timezone: "UTC",
      enabled: true,
      prompt:
        "Clean up logs older than 30 days. Archive important logs and delete temporary files. Report space freed.",
      thinking: "low",
      deliveryMode: "last",
    },
  },
  {
    id: "session-archive-daily",
    name: "Daily Session Archive",
    description: "Archive old sessions every day at 2 AM",
    category: "maintenance",
    icon: "📦",
    formState: {
      name: "Session Archive",
      schedule: "0 2 * * *",
      timezone: "UTC",
      enabled: true,
      prompt:
        "Archive sessions older than 7 days that are marked as completed. Compress and move to archive storage.",
      thinking: "minimal",
      deliveryMode: "last",
    },
  },
  {
    id: "update-check-daily",
    name: "Daily Update Check",
    description: "Check for software updates every day at 8 AM",
    category: "maintenance",
    icon: "⬆️",
    formState: {
      name: "Update Check",
      schedule: "0 8 * * *",
      timezone: "America/Los_Angeles",
      enabled: true,
      prompt:
        "Check for OpenClaw updates and security patches. Summarize what's new and recommend if update should be applied.",
      thinking: "low",
      deliveryMode: "last",
    },
  },
];

/**
 * Get templates by category
 */
export function getTemplatesByCategory(
  category: CronTemplate["category"],
): CronTemplate[] {
  return CRON_TEMPLATES.filter((t) => t.category === category);
}

/**
 * Get template by ID
 */
export function getTemplateById(id: string): CronTemplate | undefined {
  return CRON_TEMPLATES.find((t) => t.id === id);
}

/**
 * Get all template categories
 */
export function getTemplateCategories(): Array<{
  id: CronTemplate["category"];
  label: string;
  count: number;
}> {
  const categories: CronTemplate["category"][] = [
    "backup",
    "monitoring",
    "reporting",
    "scraping",
    "maintenance",
  ];

  return categories.map((cat) => ({
    id: cat,
    label: cat.charAt(0).toUpperCase() + cat.slice(1),
    count: CRON_TEMPLATES.filter((t) => t.category === cat).length,
  }));
}

/**
 * Apply template to form state
 */
export function applyTemplate(
  template: CronTemplate,
  currentState: Partial<CronFormState>,
): CronFormState {
  return {
    ...currentState,
    ...template.formState,
    // Preserve some fields from current state if they exist
    agentId: currentState.agentId,
    deliveryChannel: currentState.deliveryChannel,
    deliveryTo: currentState.deliveryTo,
  } as CronFormState;
}
