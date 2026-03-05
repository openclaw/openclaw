import type { SandboxDockerSettings } from "./types.sandbox.js";

export type WorkflowDiscordReportConfig = {
  /** Enable automatic Discord reporting when workflow completes. */
  enabled?: boolean;
  /** Discord channel ID to send workflow reports. */
  channel?: string;
  /** Discord account ID (for multi-account setups). */
  accountId?: string;
};

export type WorkflowSandboxConfig = {
  /** Enable Docker sandbox for workflow script execution. */
  enabled?: boolean;
  /** Docker sandbox settings for workflow containers. */
  docker?: SandboxDockerSettings;
  /** Auto-cleanup containers after script execution. */
  autoCleanup?: boolean;
  /** Cleanup containers after N minutes of idle time. */
  cleanupIdleMinutes?: number;
};

export type WorkflowConfig = {
  /** Enable workflow tracking and management. */
  enabled?: boolean;
  /** Directory to store workflow plans (relative to agent dir). */
  storeDir?: string;
  /** Max number of archived plans to keep per agent. */
  historyLimit?: number;
  /** Discord auto-reporting configuration. */
  discordReport?: WorkflowDiscordReportConfig;
  /** Docker sandbox configuration for workflow script execution. */
  sandbox?: WorkflowSandboxConfig;
};
