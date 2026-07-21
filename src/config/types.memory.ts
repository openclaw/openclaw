/**
 * Memory config types shared by core context-engine paths and memory host/plugin runtimes.
 * Builtin memory stays core-owned; qmd settings describe the external QMD integration.
 */
import type { SessionSendPolicyConfig } from "./types.base.js";
import type { MemorySearchConfig } from "./types.tools.js";

/** Memory backend family selected for retrieval and session memory features. */
export type MemoryBackend = "builtin" | "qmd";
/** Citation rendering mode for memory-injected context. */
export type MemoryCitationsMode = "auto" | "on" | "off";
/** QMD search command flavor used for retrieval. */
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";

/** Top-level memory config block. */
export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  /** Shared embedding/search defaults. Per-agent overrides live under agents.entries.*.memory.search. */
  search?: MemorySearchConfig;
  qmd?: MemoryQmdConfig;
};

/** QMD-specific memory backend config. */
export type MemoryQmdConfig = {
  command?: string;
  searchMode?: MemoryQmdSearchMode;
  rerank?: boolean;
  searchTool?: string;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
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

/** Retrieval and injection limits for QMD memory results. */
export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};
