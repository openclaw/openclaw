import type { AgentModelConfig } from "./types.agents-shared.js";
import type { SessionSendPolicyConfig } from "./types.base.js";

export type MemoryBackend = "builtin" | "qmd";
export type MemoryCitationsMode = "auto" | "on" | "off";
export type MemoryQmdSearchMode = "query" | "search" | "vsearch";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  sessions?: MemorySessionsConfig;
  qmd?: MemoryQmdConfig;
};

export type MemorySessionsConfig = {
  sanitization?: MemorySessionSanitizationConfig;
};

export type MemorySessionSanitizationMcpConfig = {
  enabled?: boolean;
  trustedServers?: string[];
  blockOnSandboxUnavailable?: boolean;
};

export type MemorySessionSanitizationSyntacticConfig = {
  enabled?: boolean;
  /** Maximum raw payload size in bytes before syntactic block. Default: 524288 (512KB). */
  maxPayloadBytes?: number;
  /** Maximum nested JSON depth before structural block. Default: 10. */
  maxJsonDepth?: number;
};

export type MemorySessionSanitizationSchemaValidationConfig = {
  enabled?: boolean;
};

export type MemorySessionSanitizationTwoPassConfig = {
  /** When true, definitive Stage 1 failures skip the semantic sub-agent. Default: false. */
  enabled?: boolean;
  /**
   * Rule IDs that trigger a definitive block in two-pass mode without a semantic pass.
   * Default: ["injection.ignore-previous", "injection.system-override", "injection.role-switch-capability"]
   */
  hardBlockRules?: string[];
};

export type MemorySessionSanitizationFrequencyThresholdsConfig = {
  /** Score threshold to force full semantic pass. Default: 15. */
  tier1?: number;
  /** Score threshold to add enhanced scrutiny context. Default: 30. */
  tier2?: number;
  /** Score threshold to terminate session. Default: 50. */
  tier3?: number;
};

export type MemorySessionSanitizationFrequencyConfig = {
  enabled?: boolean;
  /** Half-life for exponential decay scoring in milliseconds. Default: 60000. */
  halfLifeMs?: number;
  /** Weight assigned to each flag/violation category (keyed by rule ID prefix). */
  weights?: Record<string, number>;
  thresholds?: MemorySessionSanitizationFrequencyThresholdsConfig;
};

export type MemorySessionSanitizationAuditConfig = {
  /** Master toggle for audit writes. Sanitization still runs when false. Default: true. */
  enabled?: boolean;
  /** Verbosity tier. Default: "standard". */
  verbosity?: "minimal" | "standard" | "high" | "maximum";
  /** Retention for audit JSONL files in days. Default: 30. */
  retentionDays?: number;
  /** Retention for encrypted raw input/output sidecars (maximum tier). Defaults to retentionDays. */
  rawRetentionDays?: number;
};

export type MemorySessionSanitizationContextConfig = {
  /** Active context profile ID. Built-in: "general" | "customer-service" | "code-generation" | "research" | "admin". Default: "general". */
  profile?: string;
  /** Path to a custom profile JSON file. Required when profile is not a built-in name. */
  customProfilePath?: string;
};

export type MemorySessionSanitizationConfig = {
  enabled?: boolean;
  model?: AgentModelConfig;
  thinking?: string;
  rawMaxAge?: string;
  mcp?: MemorySessionSanitizationMcpConfig;
  syntactic?: MemorySessionSanitizationSyntacticConfig;
  schema?: MemorySessionSanitizationSchemaValidationConfig;
  twoPass?: MemorySessionSanitizationTwoPassConfig;
  frequency?: MemorySessionSanitizationFrequencyConfig;
  audit?: MemorySessionSanitizationAuditConfig;
  context?: MemorySessionSanitizationContextConfig;
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
