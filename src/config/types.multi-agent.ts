/**
 * Multi-Agent Group Transcript Configuration Types
 *
 * Enables automatic transcript sharing between multiple agents
 * bound to the same group chat on platforms where bots cannot
 * see each other's messages (e.g., Telegram, Signal).
 */

/**
 * Configuration for a single multi-agent group.
 */
export type MultiAgentGroupConfig = {
  /**
   * Agents participating in this group.
   * Optional — can be derived from bindings if omitted.
   */
  agents?: string[];

  /**
   * Path to the transcript file.
   * Supports ~ expansion for home directory.
   * @example "~/.openclaw/workspace/shared/group-transcript.md"
   */
  transcriptPath: string;

  /**
   * Number of recent entries to inject into agent context.
   * @default 20
   */
  contextLimit?: number;

  /**
   * Auto-prune entries older than N hours.
   * Set to 0 to disable automatic pruning.
   * @default 48
   */
  pruneAfterHours?: number;

  /**
   * Format for transcript entries.
   * - "markdown": Human-readable markdown format
   * - "json": Machine-readable JSON lines
   * @default "markdown"
   */
  format?: "markdown" | "json";

  /**
   * Whether to include this group's transcript in context injection.
   * Useful for temporarily disabling without removing config.
   * @default true
   */
  enabled?: boolean;
};

/**
 * Top-level configuration for all multi-agent groups.
 * Keyed by group/peer ID (e.g., Telegram group ID).
 */
export type MultiAgentGroupsConfig = {
  [groupId: string]: MultiAgentGroupConfig;
};

/**
 * Parsed transcript entry for internal use.
 */
export type TranscriptEntry = {
  timestamp: Date;
  agentId: string;
  content: string;
};

/**
 * Default configuration values.
 */
export const MULTI_AGENT_DEFAULTS = {
  contextLimit: 20,
  pruneAfterHours: 48,
  format: "markdown" as const,
  enabled: true,
} as const;
