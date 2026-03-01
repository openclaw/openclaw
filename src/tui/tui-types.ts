export type TuiOptions = {
  url?: string;
  token?: string;
  password?: string;
  session?: string;
  deliver?: boolean;
  thinking?: string;
  timeoutMs?: number;
  historyLimit?: number;
  message?: string;
};

export type ChatEvent = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
  usage?: unknown;
};

export type AgentEvent = {
  runId: string;
  stream: string;
  data?: Record<string, unknown>;
};

export type ResponseUsageMode = "on" | "off" | "tokens" | "full";

/** Token usage for a single pass (router or generation). */
export type PassTokenUsage = {
  input?: number;
  output?: number;
};

export type SessionInfo = {
  thinkingLevel?: string;
  configuredThink?: string;
  effectiveThink?: string;
  lastEffectiveThink?: string;
  currentRunId?: string;
  lastRunId?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  model?: string;
  modelProvider?: string;
  /** Runtime-resolved model currently being served for the active run. */
  servedModel?: string;
  servedModelProvider?: string;
  contextTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  responseUsage?: ResponseUsageMode;
  updatedAt?: number | null;
  displayName?: string;
  /** Router pass token usage (from generating.routingPass.pass1TokenUsage). */
  routerPassTokens?: PassTokenUsage | null;
  /** Generation pass token usage (from generating.routingPass.pass2TokenUsage or session). */
  generationPassTokens?: PassTokenUsage | null;
};

export type SessionScope = "per-sender" | "global";

export type AgentSummary = {
  id: string;
  name?: string;
};

export type GatewayStatusSummary = {
  linkChannel?: {
    id?: string;
    label?: string;
    linked?: boolean;
    authAgeMs?: number | null;
  };
  heartbeat?: {
    defaultAgentId?: string;
    agents?: Array<{
      agentId?: string;
      enabled?: boolean;
      every?: string;
      everyMs?: number | null;
    }>;
  };
  providerSummary?: string[];
  queuedSystemEvents?: string[];
  sessions?: {
    paths?: string[];
    count?: number;
    defaults?: { model?: string | null; contextTokens?: number | null };
    recent?: Array<{
      agentId?: string;
      key: string;
      kind?: string;
      updatedAt?: number | null;
      age?: number | null;
      model?: string | null;
      totalTokens?: number | null;
      contextTokens?: number | null;
      remainingTokens?: number | null;
      percentUsed?: number | null;
      flags?: string[];
    }>;
  };
};

export type TuiStateAccess = {
  agentDefaultId: string;
  sessionMainKey: string;
  sessionScope: SessionScope;
  agents: AgentSummary[];
  currentAgentId: string;
  currentSessionKey: string;
  currentSessionId: string | null;
  activeChatRunId: string | null;
  historyLoaded: boolean;
  sessionInfo: SessionInfo;
  initialSessionApplied: boolean;
  isConnected: boolean;
  autoMessageSent: boolean;
  toolsExpanded: boolean;
  showThinking: boolean;
  connectionStatus: string;
  activityStatus: string;
  statusTimeout: ReturnType<typeof setTimeout> | null;
  lastCtrlCAt: number;
};
