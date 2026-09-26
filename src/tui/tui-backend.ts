import type {
  CommandEntry,
  CommandsListParams,
  ModelChoice,
  QuestionGetResult,
  QuestionListResult,
  QuestionResolveParams,
  QuestionResolveResult,
  SessionsListParams,
  SessionsPatchParams,
  SessionsPatchResult,
  TaskSuggestion,
  TaskSuggestionsAcceptResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionInfoDefaults } from "./tui-session-info.js";
import type { AgentSummary, ResponseUsageMode, SessionInfo, SessionScope } from "./tui-types.js";

export type ChatSendOptions = {
  sessionKey: string;
  agentId?: string;
  sessionId?: string | null;
  message: string;
  thinking?: string;
  deliver?: boolean;
  timeoutMs?: number;
  runId?: string;
};

export type TuiChatSendResult = {
  runId: string;
  status?: string;
};

export type TuiImageRequest = {
  sessionKey: string;
  agentId?: string;
  source: string;
  artifactId?: string;
  signal: AbortSignal;
};

export type TuiImageData = {
  data: string;
  mimeType: string;
};

export type TuiApprovalDecision = "allow-once" | "allow-always" | "deny";

type TuiTaskSuggestionActionCapabilities = {
  canAccept: boolean;
  canDismiss: boolean;
};

export type TuiPluginApproval = {
  id: string;
  request: {
    title: string;
    description?: string | null;
    pluginId?: string | null;
    severity?: "info" | "warning" | "critical" | null;
    toolName?: string | null;
    allowedDecisions?: readonly TuiApprovalDecision[] | null;
    agentId?: string | null;
    sessionKey?: string | null;
  };
  createdAtMs: number;
  expiresAtMs: number;
};

type TuiGoalCommandOptions = {
  sessionKey: string;
  agentId?: string;
  command: string;
};

/** Event envelope delivered from Gateway or the embedded backend into the TUI. */
export type TuiEvent = {
  event: string;
  payload?: unknown;
  seq?: number;
};

/** Session-list payload rendered by session pickers and status surfaces. */
export type TuiSessionList = {
  ts: number;
  path: string;
  count: number;
  totalCount?: number;
  limitApplied?: number;
  hasMore?: boolean;
  defaults?: SessionInfoDefaults;
  sessions: Array<
    Pick<
      SessionInfo,
      | "thinkingLevel"
      | "thinkingLevels"
      | "fastMode"
      | "verboseLevel"
      | "traceLevel"
      | "reasoningLevel"
      | "model"
      | "contextTokens"
      | "inputTokens"
      | "outputTokens"
      | "totalTokens"
      | "totalTokensFresh"
      | "goal"
      | "modelProvider"
      | "agentRuntime"
      | "displayName"
    > & {
      key: string;
      sessionId?: string;
      updatedAt?: number | null;
      archived?: boolean;
      incognito?: boolean;
      sendPolicy?: string;
      responseUsage?: ResponseUsageMode;
      label?: string;
      provider?: string;
      groupChannel?: string;
      space?: string;
      subject?: string;
      chatType?: string;
      origin?: {
        label?: string;
        provider?: string;
        surface?: string;
      };
      lastChannel?: string;
      lastProvider?: string;
      lastTo?: string;
      lastAccountId?: string;
      derivedTitle?: string;
      lastMessagePreview?: string;
    }
  >;
};

export type TuiSessionDescription = {
  session: TuiSessionList["sessions"][number] | null;
  defaults?: TuiSessionList["defaults"];
};

export type TuiAgentsList = {
  defaultId: string;
  mainKey: string;
  scope: SessionScope;
  agents: AgentSummary[];
};

export type TuiModelChoice = Pick<
  ModelChoice,
  "id" | "name" | "provider" | "contextWindow" | "reasoning" | "available" | "unavailableReason"
>;

export type TuiSessionMutationResult = {
  ok?: boolean;
  key?: string;
  entry?: SessionInfo & {
    sessionId?: string;
  };
  resolved?: {
    modelProvider?: string;
    model?: string;
    agentRuntime?: SessionInfo["agentRuntime"];
    thinkingLevel?: string;
    thinkingLevels?: SessionInfo["thinkingLevels"];
  };
};

export type TuiSessionCreateOptions = {
  key: string;
  agentId?: string;
  parentSessionKey?: string;
  succeedsParent?: boolean;
};

/** Minimal backend interface shared by Gateway and embedded local TUI modes. */
export type TuiBackend = {
  connection: {
    url: string;
    token?: string;
    password?: string;
  };
  onEvent?: (evt: TuiEvent) => void;
  onConnected?: () => void;
  onConnectError?: (error: Error) => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  start: () => void;
  stop: () => void | Promise<void>;
  subscribeSessionEvents?: () => Promise<unknown>;
  sendChat: (opts: ChatSendOptions) => Promise<TuiChatSendResult>;
  /** runId optional: omit for session-scoped abort (queued turns then active). */
  abortChat: (opts: {
    sessionKey: string;
    agentId?: string;
    runId?: string;
  }) => Promise<{ ok: boolean; aborted: boolean; runIds?: string[] }>;
  loadHistory: (opts: { sessionKey: string; agentId?: string; limit?: number }) => Promise<unknown>;
  loadImage?: (opts: TuiImageRequest) => Promise<TuiImageData>;
  listSessions: (opts?: SessionsListParams) => Promise<TuiSessionList>;
  describeSession: (
    opts: Pick<ChatSendOptions, "sessionKey" | "agentId">,
  ) => Promise<TuiSessionDescription>;
  listAgents: () => Promise<TuiAgentsList>;
  patchSession: (opts: SessionsPatchParams) => Promise<SessionsPatchResult>;
  createSession: (opts: TuiSessionCreateOptions) => Promise<TuiSessionMutationResult>;
  resetSession: (
    key: string,
    reason?: "new" | "reset",
    opts?: { agentId?: string },
  ) => Promise<TuiSessionMutationResult>;
  getGatewayStatus: () => Promise<unknown>;
  listModels: (opts?: { agentId?: string }) => Promise<TuiModelChoice[]>;
  getKnownModels?: (opts?: { agentId?: string }) => TuiModelChoice[] | undefined;
  onModelsChanged?: (agentId?: string) => void;
  listCommands?: (opts?: CommandsListParams) => Promise<CommandEntry[]>;
  listPluginApprovals?: () => Promise<unknown>;
  resolvePluginApproval?: (id: string, decision: TuiApprovalDecision) => Promise<{ ok?: boolean }>;
  listQuestions?: () => Promise<QuestionListResult>;
  getQuestion?: (id: string) => Promise<QuestionGetResult>;
  resolveQuestion?: (params: QuestionResolveParams) => Promise<QuestionResolveResult>;
  getTaskSuggestionActionCapabilities?: () => TuiTaskSuggestionActionCapabilities;
  listTaskSuggestions?: () => Promise<TaskSuggestion[]>;
  acceptTaskSuggestion?: (taskId: string) => Promise<TaskSuggestionsAcceptResult>;
  dismissTaskSuggestion?: (taskId: string) => Promise<{ taskId: string; dismissed: boolean }>;
  runGoalCommand?: (
    opts: TuiGoalCommandOptions,
  ) => Promise<{ text: string; continuationPrompt?: string }>;
  runUsageCostCommand?: (opts: {
    sessionKey: string;
    agentId?: string;
  }) => Promise<{ text: string }>;
};
