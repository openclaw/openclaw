import type { SessionSendPolicyConfig } from "./types.base.js";
import type { SecretInput } from "./types.secrets.js";

export type MemoryBackend = "builtin" | "qmd";
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  mem0?: MemoryMem0Config;
  qmd?: MemoryQmdConfig;
};

export type MemoryMem0Config = {
  enabled?: boolean;
  /**
   * API key or secret reference. For local self-hosted instances this can be any
   * non-empty string (e.g. "local") — the value is sent as a Bearer token but
   * ignored by the default open-source Mem0 server.
   */
  apiKey?: SecretInput;
  /**
   * Base URL of the Mem0 REST API.
   * Defaults to `http://localhost:8000/v1` (local Docker/OSS instance).
   * For the Mem0 cloud set this to `https://api.mem0.ai/v1`.
   */
  baseUrl?: string;
  /**
   * How long (ms) to wait for a Mem0 response before falling back to local results only.
   * Defaults to 3000 ms.
   */
  fallbackTimeoutMs?: number;
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
