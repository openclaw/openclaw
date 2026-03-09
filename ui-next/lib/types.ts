/**
 * Core types for OpenClaw UI.
 * Migrated from ui/src/ui/types.ts
 */

// ============================================
// Sessions
// ============================================

export type GatewaySessionRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  surface?: string;
  subject?: string;
  room?: string;
  space?: string;
  updatedAt: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  modelProvider?: string;
  contextTokens?: number;
};

export type GatewaySessionsDefaults = {
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
};

export type SessionsListResult = {
  ts: number;
  path: string;
  count: number;
  defaults: GatewaySessionsDefaults;
  sessions: GatewaySessionRow[];
};

export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: {
    sessionId: string;
    updatedAt?: number;
    thinkingLevel?: string;
    verboseLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
  };
  resolved?: {
    modelProvider: string;
    model: string;
  };
};

// ============================================
// Models
// ============================================

export type ModelChoice = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
};

export type ModelsListResult = {
  models: ModelChoice[];
};

// ============================================
// Config
// ============================================

export type ConfigSnapshotIssue = {
  path: string;
  message: string;
};

export type ConfigSnapshot = {
  path?: string | null;
  exists?: boolean | null;
  raw?: string | null;
  hash?: string | null;
  parsed?: unknown;
  valid?: boolean | null;
  config?: Record<string, unknown> | null;
  issues?: ConfigSnapshotIssue[] | null;
};

export type ConfigUiHint = {
  label?: string;
  help?: string;
  tags?: string[];
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  itemTemplate?: unknown;
};

export type ConfigUiHints = Record<string, ConfigUiHint>;

export type ConfigSchemaResponse = {
  schema?: unknown;
  hints?: ConfigUiHints;
};

// ============================================
// Skills
// ============================================

export type SkillsStatusConfigCheck = {
  path: string;
  satisfied: boolean;
};

export type SkillInstallOption = {
  id: string;
  kind: "brew" | "node" | "go" | "uv";
  label: string;
  bins: string[];
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
  skillKey: string;
  bundled?: boolean;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: {
    bins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  configChecks: SkillsStatusConfigCheck[];
  install: SkillInstallOption[];
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
};

// ============================================
// Channels
// ============================================

export type ChannelAccountSnapshot = {
  accountId: string;
  name?: string | null;
  enabled?: boolean | null;
  configured?: boolean | null;
  linked?: boolean | null;
  running?: boolean | null;
  connected?: boolean | null;
  reconnectAttempts?: number | null;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastProbeAt?: number | null;
  mode?: string | null;
  dmPolicy?: string | null;
  allowFrom?: string[] | null;
  tokenSource?: string | null;
  botTokenSource?: string | null;
  appTokenSource?: string | null;
  credentialSource?: string | null;
  audienceType?: string | null;
  audience?: string | null;
  webhookPath?: string | null;
  webhookUrl?: string | null;
  baseUrl?: string | null;
  allowUnmentionedGroups?: boolean | null;
  cliPath?: string | null;
  dbPath?: string | null;
  port?: number | null;
  probe?: unknown;
  audit?: unknown;
  application?: unknown;
};

export type ChannelUiMetaEntry = {
  id: string;
  label: string;
  detailLabel: string;
  systemImage?: string;
};

export type ChannelsStatusSnapshot = {
  ts: number;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  channelDetailLabels?: Record<string, string>;
  channelSystemImages?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  channels: Record<string, unknown>;
  channelAccounts: Record<string, ChannelAccountSnapshot[]>;
  channelDefaultAccountId: Record<string, string>;
};

// ============================================
// Logs
// ============================================

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogEntry = {
  raw: string;
  time?: string | null;
  level?: LogLevel | null;
  subsystem?: string | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
};

// ============================================
// Cron
// ============================================

export const CRON_CHANNEL_LAST = "last";

export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number };

export type CronSessionTarget = "main" | "isolated";
export type CronWakeMode = "next-heartbeat" | "now";

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "agentTurn";
      message: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
    };

export type CronDelivery = {
  mode: "none" | "announce" | "webhook";
  channel?: string;
  to?: string;
  bestEffort?: boolean;
};

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
};

export type CronJob = {
  id: string;
  agentId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  delivery?: CronDelivery;
  state?: CronJobState;
};

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>;
};

export type CronStatus = {
  enabled: boolean;
  jobs: number;
  nextWakeAtMs?: number | null;
};

export type CronJobsEnabledFilter = "all" | "enabled" | "disabled";
export type CronJobsSortBy = "nextRunAtMs" | "updatedAtMs" | "name";
export type CronSortDir = "asc" | "desc";
export type CronRunsStatusFilter = "all" | "ok" | "error" | "skipped";
export type CronRunsStatusValue = "ok" | "error" | "skipped";
export type CronDeliveryStatus = "delivered" | "not-delivered" | "unknown" | "not-requested";
export type CronRunScope = "job" | "all";

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  jobName?: string;
  status?: CronRunsStatusValue;
  durationMs?: number;
  error?: string;
  summary?: string;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  delivered?: boolean;
  runAtMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  sessionId?: string;
  sessionKey?: string;
};

export type CronJobsListResult = {
  jobs?: CronJob[];
  total?: number;
  offset?: number;
  limit?: number;
  hasMore?: boolean;
  nextOffset?: number | null;
};

export type CronRunsResult = {
  entries?: CronRunLogEntry[];
  total?: number;
  offset?: number;
  limit?: number;
  hasMore?: boolean;
  nextOffset?: number | null;
};

// ============================================
// Agents
// ============================================

export type GatewayAgentRow = {
  id: string;
  name?: string;
  identity?: {
    name?: string;
    theme?: string;
    emoji?: string;
    avatar?: string;
    avatarUrl?: string;
  };
};

export type AgentsListResult = {
  defaultId: string;
  mainKey: string;
  scope: string;
  agents: GatewayAgentRow[];
};

export type AgentIdentityResult = {
  agentId: string;
  name: string;
  avatar: string;
  emoji?: string;
};

export type AgentFileEntry = {
  path: string;
  name?: string;
  missing?: boolean;
  size?: number;
  contentBase64?: string;
  sizeBytes?: number;
  modifiedAtMs?: number;
  updatedAtMs?: number;
  content?: string;
};

export type AgentsFilesListResult = {
  agentId: string;
  workspace: string;
  files: AgentFileEntry[];
};

export type AgentsFilesGetResult = {
  agentId: string;
  workspace: string;
  file: AgentFileEntry;
};

export type AgentsFilesSetResult = {
  ok: true;
  agentId: string;
  workspace: string;
  file: AgentFileEntry;
};

export type ToolsCatalogTool = {
  id: string;
  label: string;
  description: string;
  source: "core" | "plugin";
  pluginId?: string;
  optional?: boolean;
};

export type ToolsCatalogGroup = {
  id: string;
  label: string;
  source: "core" | "plugin";
  pluginId?: string;
  tools: ToolsCatalogTool[];
};

export type ToolsCatalogResult = {
  agentId: string;
  profiles: Array<{ id: string; label: string }>;
  groups: ToolsCatalogGroup[];
};
