/**
 * Memory config types shared by core context-engine paths and memory host/plugin runtimes.
 * Builtin memory stays core-owned; qmd settings describe the external QMD integration.
 */
import type { SessionSendPolicyConfig } from "./types.base.js";
import type { SecretInput } from "./types.secrets.js";

/** Memory backend family selected for retrieval and session memory features. */
export type MemoryBackend = "builtin" | "qmd" | "mem0" | "hybrid";
/** Citation rendering mode for memory-injected context. */
export type MemoryCitationsMode = "auto" | "on" | "off";
/** QMD search command flavor used for retrieval. */
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";
/** QMD startup/update scheduling mode. */
export type MemoryQmdStartupMode = "off" | "idle" | "immediate";
export type MemoryHybridTarget = "qmd" | "mem0" | "both";
export type MemoryHybridReadOrder = "qmd" | "mem0";
export type MemoryHybridMode = "dual" | "routed";
export type MemoryHybridSuccessPolicy = "any" | "all";
export type MemoryHybridRouteScope = "read" | "write" | "both";
export type MemoryHybridRouteSource = "query" | "conversation" | "knowledge";
export type MemoryHybridRoutePriority = "normal" | "critical";

/** Top-level memory config block. */
export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
  mem0?: MemoryMem0Config;
  hybrid?: MemoryHybridConfig;
};

export type MemoryHybridConfig = {
  read?: MemoryHybridReadConfig;
  write?: MemoryHybridWriteConfig;
  routing?: MemoryHybridRouteRule[];
};

export type MemoryHybridReadConfig = {
  mode?: MemoryHybridMode;
  order?: MemoryHybridReadOrder[];
  maxResults?: number;
  dedupe?: boolean;
};

export type MemoryHybridWriteConfig = {
  mode?: MemoryHybridMode;
  successPolicy?: MemoryHybridSuccessPolicy;
};

export type MemoryHybridRouteRule = {
  scope?: MemoryHybridRouteScope;
  source?: MemoryHybridRouteSource;
  priority?: MemoryHybridRoutePriority;
  tags?: string[];
  queryIncludes?: string[];
  target: MemoryHybridTarget;
};

export type MemoryMem0Config = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: SecretInput;
  userIdPrefix?: string;
  agentIdPrefix?: string;
  searchPath?: string;
  addPath?: string;
  topK?: number;
  threshold?: number;
  timeoutMs?: number;
};

/** QMD-specific memory backend config. */
export type MemoryQmdConfig = {
  command?: string;
  mcporter?: MemoryQmdMcporterConfig;
  searchMode?: MemoryQmdSearchMode;
  rerank?: boolean;
  searchTool?: string;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

/** mcporter daemon integration for long-lived QMD MCP access. */
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

/** Additional QMD index path entry. */
export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

/** Session export settings for QMD memory indexing. */
export type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

/** Background update and embedding schedule for QMD memory. */
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

/** Retrieval and injection limits for QMD memory results. */
export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};
