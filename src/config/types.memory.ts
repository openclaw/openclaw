import type { SessionSendPolicyConfig } from "./types.base.js";

export type MemoryBackend = "builtin" | "qmd" | "cortex";
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
  cortex?: MemoryCortexConfig;
};

/**
 * Cortex Memory backend configuration.
 *
 * Cortex Memory is a high-performance, persistent, and intelligent long-term memory system
 * that gives AI agents the ability to remember, learn, and personalize interactions across sessions.
 *
 * Features:
 * - Three-tier memory hierarchy (L0 Abstract → L1 Overview → L2 Detail)
 * - Virtual filesystem with cortex:// URI scheme
 * - Vector-based semantic search via Qdrant
 * - Multi-tenancy support with isolated memory spaces
 *
 * @see https://github.com/sopaco/cortex-mem
 */
export type MemoryCortexConfig = {
  /**
   * URL of the Cortex Memory service (cortex-mem-service).
   * Default: "http://localhost:8085"
   */
  serviceUrl?: string;

  /**
   * Tenant identifier for memory isolation.
   * Each tenant has completely isolated memory spaces.
   * Default: "default"
   */
  tenant?: string;

  /**
   * API key for authenticating with the Cortex Memory service.
   * Optional - set if the service requires authentication.
   */
  apiKey?: string;

  /**
   * Request timeout in milliseconds for Cortex Memory API calls.
   * Default: 30000 (30 seconds)
   */
  timeoutMs?: number;

  /**
   * Maximum number of search results to return.
   * Default: 10
   */
  maxResults?: number;

  /**
   * Minimum relevance score threshold for search results (0.0-1.0).
   * Default: 0.4
   */
  minScore?: number;

  /**
   * Search scope: "session", "user", or "agent".
   * - session: Search within conversation sessions
   * - user: Search user preferences and entities
   * - agent: Search agent cases and skills
   * Default: "session"
   */
  scope?: MemoryCortexSearchScope;

  /**
   * Whether to automatically create sessions when adding messages.
   * Default: true
   */
  autoCreateSession?: boolean;

  /**
   * Whether to automatically extract memories when sessions are closed.
   * Default: true
   */
  autoExtract?: boolean;
};

export type MemoryCortexSearchScope = "session" | "user" | "agent";

export type MemoryQmdConfig = {
  command?: string;
  mcporter?: MemoryQmdMcporterConfig;
  searchMode?: MemoryQmdSearchMode;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
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
