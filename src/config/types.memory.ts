import type { SessionSendPolicyConfig } from "./types.base.js";

export type MemoryBackend = "builtin" | "qmd";
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";
export type MemoryQmdStartupMode = "off" | "idle" | "immediate";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
};

export type MemoryQmdConfig = {
  command?: string;
  mcporter?: MemoryQmdMcporterConfig;
  searchMode?: MemoryQmdSearchMode;
  searchTool?: string;
  includeDefaultMemory?: boolean;
  channelScopes?: MemoryQmdChannelScopesConfig;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

export type MemoryQmdChannelScopesConfig = {
  /** Experimental: restrict QMD memory_search collections from the current agent/channel/DM route. */
  enabled?: boolean;
  /** Include the configured global memory collection in route-scoped searches (default: true). */
  includeGlobal?: boolean;
  /** Include the current agent's private memory collection in route-scoped searches (default: true). */
  includeAgentPrivate?: boolean;
  /** Require a non-empty reason when memory_search asks for cross-scope collections (default: true). */
  requireOverrideReason?: boolean;
  collections?: {
    /** Collection name for global memory (default: memory-global-main). */
    global?: string;
    /** Prefix for agent-private collections (default: memory-private-). */
    agentPrivatePrefix?: string;
    /** Prefix for Slack channel collections (default: memory-slack-). */
    slackChannelPrefix?: string;
    /** Prefix for Slack DM collections (default: memory-dm-). */
    slackDmPrefix?: string;
  };
};

export type MemoryQmdMcporterConfig = {
  /**
   * Route QMD searches through mcporter (MCP runtime) instead of spawning `qmd` per query.
   * Requires:
   * - `mcporter` installed and on PATH
   * - A configured mcporter server that runs `qmd mcp` with `lifecycle: keep-alive`
   */
  enabled?: boolean;
  /** mcporter server name (defaults to "qmd") */
  serverName?: string;
  /** Start the mcporter daemon automatically (defaults to true when enabled). */
  startDaemon?: boolean;
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
  startup?: MemoryQmdStartupMode;
  startupDelayMs?: number;
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
