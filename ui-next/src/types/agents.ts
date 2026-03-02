export type AgentIdentity = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
};

export type AgentRow = {
  id: string;
  name?: string;
  role?: string;
  department?: string;
  identity?: AgentIdentity;
};

export type AgentListResult = {
  defaultId: string;
  mainKey: string;
  agents: AgentRow[];
};

export type AgentFile = {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
  content?: string;
};

export type AgentFilesListResult = {
  agentId: string;
  workspace: string;
  files: AgentFile[];
};

export type AgentFileGetResult = {
  agentId: string;
  workspace: string;
  file: AgentFile;
};

export type AgentFileSetResult = {
  ok: boolean;
  agentId: string;
  workspace: string;
  file: AgentFile;
};

// Agent identity (full, from agent.identity RPC)
export type AgentIdentityResult = {
  agentId: string;
  name?: string;
  avatar?: string;
  emoji?: string;
};

// Skill types
export type SkillInstallOption = {
  id: string;
  kind: "brew" | "node" | "go" | "uv";
  label: string;
  bins: string[];
};

export type SkillConfigCheck = {
  path: string;
  value: unknown;
  satisfied: boolean;
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  bundled?: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
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
  configChecks: SkillConfigCheck[];
  install: SkillInstallOption[];
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
};

export type SkillUpdateResult = {
  ok: boolean;
  skillKey: string;
  config: {
    enabled?: boolean;
    apiKey?: string;
    env?: Record<string, string>;
  };
};

// Channel types
export type ChannelAccount = {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  linked?: boolean;
  running?: boolean;
  connected?: boolean;
  reconnectAttempts?: number;
  lastConnectedAt?: number;
  lastError?: string;
  lastStartAt?: number;
  lastStopAt?: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  mode?: string;
  dmPolicy?: string;
  allowFrom?: string[];
  tokenSource?: string;
  botTokenSource?: string;
  appTokenSource?: string;
  credentialSource?: string;
  audienceType?: string;
  audience?: string;
  webhookPath?: string;
  webhookUrl?: string;
  baseUrl?: string;
  allowUnmentionedGroups?: boolean;
  port?: number;
  probe?: unknown;
};

export type ChannelMeta = {
  id: string;
  label: string;
  detailLabel: string;
  systemImage?: string;
};

export type ChannelsStatusResult = {
  ts: number;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  channelDetailLabels?: Record<string, string>;
  channelSystemImages?: Record<string, string>;
  channelMeta?: ChannelMeta[];
  channels: Record<string, unknown>;
  channelAccounts: Record<string, ChannelAccount[]>;
  channelDefaultAccountId: Record<string, string>;
};

// Cron types
export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

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
  mode: "none" | "announce";
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
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  payload: CronPayload;
  delivery?: CronDelivery;
  state?: CronJobState;
};

export type CronStatusResult = {
  enabled: boolean;
  jobs: number;
  nextWakeAtMs?: number;
};

export type CronListResult = {
  jobs: CronJob[];
};

// Config types
export type ConfigGetResult = {
  path?: string;
  exists?: boolean;
  raw?: string;
  hash?: string;
  parsed?: unknown;
  valid?: boolean;
  config?: Record<string, unknown>;
  issues?: Array<{ path: string; message: string }>;
};

// Models types
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

// JSON Schema types (for config form rendering)
export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  nullable?: boolean;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

// Config schema / UI hints types
export type ConfigUiHint = {
  label?: string;
  help?: string;
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  itemTemplate?: unknown;
};

export type ConfigUiHints = Record<string, ConfigUiHint>;

export type ConfigSchemaResponse = {
  schema: JsonSchema;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

// Org chart / hierarchy types
export type OrgChartNode = {
  agentId: string;
  name: string;
  emoji?: string;
  model?: string;
  role?: string;
  department?: string;
  hasSoul: boolean;
  hasIdentity: boolean;
  children: OrgChartNode[];
};

export type AgentHierarchy = {
  roots: OrgChartNode[];
  nodeCount: number;
};

export type SidebarAgentEntry = {
  agentId: string;
  depth: number;
};
