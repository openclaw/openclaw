import type { SessionSendPolicyConfig } from "./types.base.js";

export type MemoryBackend = "builtin" | "qmd" | "postgres";
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
  postgres?: MemoryPostgresConfig;
};

export type MemoryPostgresConfig = {
  /** PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/dbname). */
  connectionString?: string;
  /** Individual connection fields (alternative to connectionString). */
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** SSL mode for the connection. */
  ssl?: boolean | "require" | "prefer" | "disable";
  /** Table name prefix for multi-agent isolation (default: "openclaw_memory"). */
  tablePrefix?: string;
  /** Embedding configuration. */
  embedding?: MemoryPostgresEmbeddingConfig;
  /** Hybrid search weights. */
  hybrid?: {
    enabled?: boolean;
    vectorWeight?: number;
    textWeight?: number;
  };
  /** Paths to index (same format as QMD paths). */
  paths?: MemoryQmdIndexPath[];
  /** Include default MEMORY.md and memory/ directory. */
  includeDefaultMemory?: boolean;
  /** Session transcript indexing. */
  sessions?: MemoryQmdSessionConfig;
  /** Update/sync intervals. */
  update?: MemoryQmdUpdateConfig;
  /** Search limits. */
  limits?: MemoryQmdLimitsConfig;
  /** Scope policy. */
  scope?: SessionSendPolicyConfig;
};

export type MemoryPostgresEmbeddingConfig = {
  /** Embedding provider to use (reuses OpenClaw's provider infrastructure). */
  provider?: "openai" | "voyage" | "gemini";
  /** Embedding model name. */
  model?: string;
  /** Vector dimensions (must match the model output). */
  dimensions?: number;
};

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
