import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Command } from "commander";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthProfileCredential, OAuthCredential } from "../agents/auth-profiles/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ChannelDock } from "../channels/dock.js";
import type { ChannelId, ChannelPlugin } from "../channels/plugins/types.js";
import type { createVpsAwareOAuthHandlers } from "../commands/oauth-flow.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type { InternalHookHandler } from "../hooks/internal-hooks.js";
import type { HookEntry } from "../hooks/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { PluginRuntime } from "./runtime/types.js";

export type { PluginRuntime } from "./runtime/types.js";
export type { AnyAgentTool } from "../agents/tools/common.js";

export type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type PluginConfigUiHint = {
  label?: string;
  help?: string;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
};

export type PluginKind = "memory";

export type PluginConfigValidation =
  | { ok: true; value?: unknown }
  | { ok: false; errors: string[] };

export type OpenClawPluginConfigSchema = {
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: {
      issues?: Array<{ path: Array<string | number>; message: string }>;
    };
  };
  parse?: (value: unknown) => unknown;
  validate?: (value: unknown) => PluginConfigValidation;
  uiHints?: Record<string, PluginConfigUiHint>;
  jsonSchema?: Record<string, unknown>;
};

export type OpenClawPluginToolContext = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
};

export type OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
) => AnyAgentTool | AnyAgentTool[] | null | undefined;

export type OpenClawPluginToolOptions = {
  name?: string;
  names?: string[];
  optional?: boolean;
};

export type OpenClawPluginHookOptions = {
  entry?: HookEntry;
  name?: string;
  description?: string;
  register?: boolean;
};

export type PluginHookExecutionMode = "fail-open" | "fail-closed";
export type PluginHookTimeoutMode = "fail-open" | "fail-closed";

export type PluginHookRetryPolicy = {
  count: number;
  backoffMs?: number;
};

export type PluginHookScope = {
  channels?: string[];
  agentIds?: string[];
  toolNames?: string[];
};

export type ProviderAuthKind = "oauth" | "api_key" | "token" | "device_code" | "custom";

export type ProviderAuthResult = {
  profiles: Array<{ profileId: string; credential: AuthProfileCredential }>;
  configPatch?: Partial<OpenClawConfig>;
  defaultModel?: string;
  notes?: string[];
};

export type ProviderAuthContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  oauth: {
    createVpsAwareHandlers: typeof createVpsAwareOAuthHandlers;
  };
};

export type ProviderAuthMethod = {
  id: string;
  label: string;
  hint?: string;
  kind: ProviderAuthKind;
  run: (ctx: ProviderAuthContext) => Promise<ProviderAuthResult>;
};

export type ProviderPlugin = {
  id: string;
  label: string;
  docsPath?: string;
  aliases?: string[];
  envVars?: string[];
  models?: ModelProviderConfig;
  auth: ProviderAuthMethod[];
  formatApiKey?: (cred: AuthProfileCredential) => string;
  refreshOAuth?: (cred: OAuthCredential) => Promise<OAuthCredential>;
};

export type OpenClawPluginGatewayMethod = {
  method: string;
  handler: GatewayRequestHandler;
};

// =============================================================================
// Plugin Commands
// =============================================================================

/**
 * Context passed to plugin command handlers.
 */
export type PluginCommandContext = {
  /** The sender's identifier (e.g., Telegram user ID) */
  senderId?: string;
  /** The channel/surface (e.g., "telegram", "discord") */
  channel: string;
  /** Provider channel id (e.g., "telegram") */
  channelId?: ChannelId;
  /** Whether the sender is on the allowlist */
  isAuthorizedSender: boolean;
  /** Raw command arguments after the command name */
  args?: string;
  /** The full normalized command body */
  commandBody: string;
  /** Current OpenClaw configuration */
  config: OpenClawConfig;
  /** Raw "From" value (channel-scoped id) */
  from?: string;
  /** Raw "To" value (channel-scoped id) */
  to?: string;
  /** Account id for multi-account channels */
  accountId?: string;
  /** Thread/topic id if available */
  messageThreadId?: number;
};

/**
 * Result returned by a plugin command handler.
 */
export type PluginCommandResult = ReplyPayload;

/**
 * Handler function for plugin commands.
 */
export type PluginCommandHandler = (
  ctx: PluginCommandContext,
) => PluginCommandResult | Promise<PluginCommandResult>;

/**
 * Definition for a plugin-registered command.
 */
export type OpenClawPluginCommandDefinition = {
  /** Command name without leading slash (e.g., "tts") */
  name: string;
  /** Description shown in /help and command menus */
  description: string;
  /** Whether this command accepts arguments */
  acceptsArgs?: boolean;
  /** Whether only authorized senders can use this command (default: true) */
  requireAuth?: boolean;
  /** The handler function */
  handler: PluginCommandHandler;
};

export type OpenClawPluginHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean> | boolean;

export type OpenClawPluginHttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

export type OpenClawPluginCliContext = {
  program: Command;
  config: OpenClawConfig;
  workspaceDir?: string;
  logger: PluginLogger;
};

export type OpenClawPluginCliRegistrar = (ctx: OpenClawPluginCliContext) => void | Promise<void>;

export type OpenClawPluginServiceContext = {
  config: OpenClawConfig;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
};

export type OpenClawPluginService = {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
};

export type OpenClawPluginChannelRegistration = {
  plugin: ChannelPlugin;
  dock?: ChannelDock;
};

export type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: PluginKind;
  configSchema?: OpenClawPluginConfigSchema;
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
  activate?: (api: OpenClawPluginApi) => void | Promise<void>;
};

export type OpenClawPluginModule =
  | OpenClawPluginDefinition
  | ((api: OpenClawPluginApi) => void | Promise<void>);

export type OpenClawPluginApi = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  registerTool: (
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: OpenClawPluginToolOptions,
  ) => void;
  registerHook: (
    events: string | string[],
    handler: InternalHookHandler,
    opts?: OpenClawPluginHookOptions,
  ) => void;
  registerHttpHandler: (handler: OpenClawPluginHttpHandler) => void;
  registerHttpRoute: (params: { path: string; handler: OpenClawPluginHttpRouteHandler }) => void;
  registerChannel: (registration: OpenClawPluginChannelRegistration | ChannelPlugin) => void;
  registerGatewayMethod: (method: string, handler: GatewayRequestHandler) => void;
  registerCli: (registrar: OpenClawPluginCliRegistrar, opts?: { commands?: string[] }) => void;
  registerService: (service: OpenClawPluginService) => void;
  registerProvider: (provider: ProviderPlugin) => void;
  /**
   * Register a custom command that bypasses the LLM agent.
   * Plugin commands are processed before built-in commands and before agent invocation.
   * Use this for simple state-toggling or status commands that don't need AI reasoning.
   */
  registerCommand: (command: OpenClawPluginCommandDefinition) => void;
  resolvePath: (input: string) => string;
  /** Register a lifecycle hook handler */
  on: <K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: PluginHookOptions<K>,
  ) => void;
  lifecycle: {
    on: <P extends PluginLifecyclePhase>(
      phase: P,
      handler: PluginLifecycleHookHandlerMap[P],
      options?: PluginLifecycleHookOptions<P>,
    ) => void;
  };
};

export type PluginLifecyclePhase =
  | "preBoot"
  | "postBoot"
  | "preShutdown"
  | "postShutdown"
  | "preAgent"
  | "preRequest"
  | "preRecall"
  | "preResponse"
  | "preToolExecution"
  | "preCompaction"
  | "postRequest"
  | "postResponse"
  | "postToolExecution"
  | "postCompaction"
  | "postRecall"
  | "postRequestIngress"
  | "onResponseError"
  | "onToolError"
  | "onError"
  | "boot.pre"
  | "boot.post"
  | "message.pre"
  | "message.post"
  | "tool.pre"
  | "tool.post"
  | "agent.pre"
  | "agent.post"
  | "request.pre"
  | "request.post"
  | "recall.pre"
  | "recall.post"
  | "error"
  | "response.error"
  | "tool.error"
  | "memory.compaction.pre"
  | "memory.compaction.post"
  | "shutdown.pre"
  | "shutdown.post";

type PluginCanonicalLifecyclePayloadMap = {
  "boot.pre": PluginHookGatewayPreStartEvent;
  "boot.post": PluginHookGatewayStartEvent;
  "message.pre": PluginHookMessageSendingEvent;
  "message.post": PluginHookMessageSentEvent;
  "tool.pre": PluginHookBeforeToolCallEvent;
  "tool.post": PluginHookAfterToolCallEvent;
  "agent.pre": PluginHookBeforeAgentStartEvent;
  "agent.post": PluginHookAgentEndEvent;
  "request.pre": PluginHookMessageReceivedEvent;
  "request.post": PluginHookRequestPostEvent;
  "recall.pre": PluginHookBeforeRecallEvent;
  "recall.post": PluginHookAfterRecallEvent;
  error: PluginHookAgentErrorEvent;
  "response.error": PluginHookResponseErrorEvent;
  "tool.error": PluginHookToolErrorEvent;
  "memory.compaction.pre": PluginHookBeforeCompactionEvent;
  "memory.compaction.post": PluginHookAfterCompactionEvent;
  "shutdown.pre": { reason?: string };
  "shutdown.post": PluginHookGatewayStopEvent;
};

type PluginLifecycleAliasToCanonicalPhaseMap = {
  preBoot: "boot.pre";
  postBoot: "boot.post";
  preShutdown: "shutdown.pre";
  postShutdown: "shutdown.post";
  preAgent: "agent.pre";
  preRequest: "request.pre";
  postRequestIngress: "request.post";
  preRecall: "recall.pre";
  postRecall: "recall.post";
  preResponse: "message.pre";
  preToolExecution: "tool.pre";
  preCompaction: "memory.compaction.pre";
  postRequest: "agent.post";
  postResponse: "message.post";
  postToolExecution: "tool.post";
  postCompaction: "memory.compaction.post";
  onResponseError: "response.error";
  onToolError: "tool.error";
  onError: "error";
};

type PluginLifecycleAliasPayloadMap = {
  [K in keyof PluginLifecycleAliasToCanonicalPhaseMap]: PluginCanonicalLifecyclePayloadMap[PluginLifecycleAliasToCanonicalPhaseMap[K]];
};
export type PluginLifecyclePayloadMap = PluginCanonicalLifecyclePayloadMap &
  PluginLifecycleAliasPayloadMap;

export type PluginLifecycleHookResult = {
  continue?: boolean;
  mutate?: Record<string, unknown>;
  reason?: string;
  data?: Record<string, unknown>;
};

export type PluginLifecycleHookContext<P extends PluginLifecyclePhase = PluginLifecyclePhase> = {
  phase: P;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type PluginLifecycleHookHandlerMap = {
  [P in PluginLifecyclePhase]: (
    payload: PluginLifecyclePayloadMap[P],
    context: PluginLifecycleHookContext<P>,
  ) => Promise<PluginLifecycleHookResult | void> | PluginLifecycleHookResult | void;
};

export type PluginLifecycleHookOptions<P extends PluginLifecyclePhase> = {
  priority?: number;
  timeoutMs?: number;
  mode?: PluginHookExecutionMode;
  onTimeout?: PluginHookTimeoutMode;
  retry?: PluginHookRetryPolicy;
  maxConcurrency?: number;
  scope?: PluginHookScope;
  condition?: (
    payload: PluginLifecyclePayloadMap[P],
    context: PluginLifecycleHookContext<P>,
  ) => boolean | Promise<boolean>;
};

export type PluginHookOptions<K extends PluginHookName> = {
  priority?: number;
  timeoutMs?: number;
  mode?: PluginHookExecutionMode;
  onTimeout?: PluginHookTimeoutMode;
  retry?: PluginHookRetryPolicy;
  maxConcurrency?: number;
  scope?: PluginHookScope;
  condition?: (
    event: Parameters<PluginHookHandlerMap[K]>[0],
    ctx: Parameters<PluginHookHandlerMap[K]>[1],
  ) => boolean | Promise<boolean>;
};

export type PluginOrigin = "bundled" | "global" | "workspace" | "config";

export type PluginDiagnostic = {
  level: "warn" | "error";
  message: string;
  pluginId?: string;
  source?: string;
};

// ============================================================================
// Plugin Hooks
// ============================================================================

export type PluginHookName =
  | "gateway_pre_start"
  | "gateway_pre_stop"
  | "before_agent_start"
  | "llm_input"
  | "llm_output"
  | "before_recall"
  | "after_recall"
  | "request_post"
  | "agent_end"
  | "agent_error"
  | "before_compaction"
  | "after_compaction"
  | "before_reset"
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "response_error"
  | "before_tool_call"
  | "after_tool_call"
  | "tool_error"
  | "tool_result_persist"
  | "session_start"
  | "session_end"
  | "gateway_start"
  | "gateway_stop";

// Agent context shared across agent hooks
export type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
};

// before_agent_start hook
export type PluginHookBeforeAgentStartEvent = {
  prompt: string;
  messages?: unknown[];
};

export type PluginHookBeforeAgentStartResult = {
  systemPrompt?: string;
  prependContext?: string;
};

// llm_input hook
export type PluginHookLlmInputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};

// llm_output hook
export type PluginHookLlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

// before_recall hook
export type PluginHookBeforeRecallEvent = {
  query: string;
  maxResults?: number;
  minScore?: number;
};

export type PluginHookBeforeRecallResult = {
  query?: string;
  maxResults?: number;
  minScore?: number;
};

// agent_end hook
export type PluginHookAgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

// agent_error hook
export type PluginHookAgentErrorEvent = PluginHookAgentEndEvent;

// Compaction hooks
export type PluginHookBeforeCompactionEvent = {
  /** Total messages in the session before any truncation or compaction */
  messageCount: number;
  /** Messages being fed to the compaction LLM (after history-limit truncation) */
  compactingCount?: number;
  tokenCount?: number;
  messages?: unknown[];
  /** Path to the session JSONL transcript. All messages are already on disk
   *  before compaction starts, so plugins can read this file asynchronously
   *  and process in parallel with the compaction LLM call. */
  sessionFile?: string;
};

// before_reset hook — fired when /new or /reset clears a session
export type PluginHookBeforeResetEvent = {
  sessionFile?: string;
  messages?: unknown[];
  reason?: string;
};

export type PluginHookAfterCompactionEvent = {
  messageCount: number;
  tokenCount?: number;
  compactedCount: number;
  /** Path to the session JSONL transcript. All pre-compaction messages are
   *  preserved on disk, so plugins can read and process them asynchronously
   *  without blocking the compaction pipeline. */
  sessionFile?: string;
};

// Message context
export type PluginHookMessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
};

// message_received hook
export type PluginHookMessageReceivedEvent = {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
};

export type PluginHookMessageReceivedResult = {
  content?: string;
  metadata?: Record<string, unknown>;
  cancel?: boolean;
};

export type PluginHookRequestPostEvent = {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
};

// message_sending hook
export type PluginHookMessageSendingEvent = {
  to: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type PluginHookMessageSendingResult = {
  content?: string;
  cancel?: boolean;
};

// message_sent hook
export type PluginHookMessageSentEvent = {
  to: string;
  content: string;
  success: boolean;
  error?: string;
};

export type PluginHookResponseErrorEvent = {
  to: string;
  content: string;
  error: string;
};

// Tool context
export type PluginHookToolContext = {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
};

// before_tool_call hook
export type PluginHookBeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
};

export type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
};

// after_tool_call hook
export type PluginHookAfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

export type PluginHookToolErrorEvent = {
  toolName: string;
  params: Record<string, unknown>;
  error: string;
  durationMs?: number;
};

export type PluginHookAfterRecallEvent = {
  query: string;
  maxResults?: number;
  minScore?: number;
  resultCount: number;
  durationMs?: number;
};

// tool_result_persist hook
export type PluginHookToolResultPersistContext = {
  agentId?: string;
  sessionKey?: string;
  toolName?: string;
  toolCallId?: string;
};

export type PluginHookToolResultPersistEvent = {
  toolName?: string;
  toolCallId?: string;
  /**
   * The toolResult message about to be written to the session transcript.
   * Handlers may return a modified message (e.g. drop non-essential fields).
   */
  message: AgentMessage;
  /** True when the tool result was synthesized by a guard/repair step. */
  isSynthetic?: boolean;
};

export type PluginHookToolResultPersistResult = {
  message?: AgentMessage;
};

// Session context
export type PluginHookSessionContext = {
  agentId?: string;
  sessionId: string;
};

// session_start hook
export type PluginHookSessionStartEvent = {
  sessionId: string;
  resumedFrom?: string;
};

// session_end hook
export type PluginHookSessionEndEvent = {
  sessionId: string;
  messageCount: number;
  durationMs?: number;
};

// Gateway context
export type PluginHookGatewayContext = {
  port?: number;
};

// gateway_pre_start hook
export type PluginHookGatewayPreStartEvent = {
  port: number;
};

// gateway_pre_stop hook
export type PluginHookGatewayPreStopEvent = {
  reason?: string;
};

// gateway_start hook
export type PluginHookGatewayStartEvent = {
  port: number;
};

// gateway_stop hook
export type PluginHookGatewayStopEvent = {
  reason?: string;
};

// Hook handler types mapped by hook name
export type PluginHookHandlerMap = {
  gateway_pre_start: (
    event: PluginHookGatewayPreStartEvent,
    ctx: PluginHookGatewayContext,
  ) => Promise<void> | void;
  gateway_pre_stop: (
    event: PluginHookGatewayPreStopEvent,
    ctx: PluginHookGatewayContext,
  ) => Promise<void> | void;
  before_agent_start: (
    event: PluginHookBeforeAgentStartEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforeAgentStartResult | void> | PluginHookBeforeAgentStartResult | void;
  llm_input: (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  llm_output: (
    event: PluginHookLlmOutputEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<void> | void;
  before_recall: (
    event: PluginHookBeforeRecallEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookBeforeRecallResult | void> | PluginHookBeforeRecallResult | void;
  after_recall: (
    event: PluginHookAfterRecallEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<void> | void;
  agent_end: (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
  agent_error: (
    event: PluginHookAgentErrorEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<void> | void;
  before_compaction: (
    event: PluginHookBeforeCompactionEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<void> | void;
  after_compaction: (
    event: PluginHookAfterCompactionEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<void> | void;
  before_reset: (
    event: PluginHookBeforeResetEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<void> | void;
  message_received: (
    event: PluginHookMessageReceivedEvent,
    ctx: PluginHookMessageContext,
  ) => Promise<PluginHookMessageReceivedResult | void> | PluginHookMessageReceivedResult | void;
  request_post: (
    event: PluginHookRequestPostEvent,
    ctx: PluginHookMessageContext,
  ) => Promise<void> | void;
  message_sending: (
    event: PluginHookMessageSendingEvent,
    ctx: PluginHookMessageContext,
  ) => Promise<PluginHookMessageSendingResult | void> | PluginHookMessageSendingResult | void;
  message_sent: (
    event: PluginHookMessageSentEvent,
    ctx: PluginHookMessageContext,
  ) => Promise<void> | void;
  response_error: (
    event: PluginHookResponseErrorEvent,
    ctx: PluginHookMessageContext,
  ) => Promise<void> | void;
  before_tool_call: (
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ) => Promise<PluginHookBeforeToolCallResult | void> | PluginHookBeforeToolCallResult | void;
  after_tool_call: (
    event: PluginHookAfterToolCallEvent,
    ctx: PluginHookToolContext,
  ) => Promise<void> | void;
  tool_error: (event: PluginHookToolErrorEvent, ctx: PluginHookToolContext) => Promise<void> | void;
  tool_result_persist: (
    event: PluginHookToolResultPersistEvent,
    ctx: PluginHookToolResultPersistContext,
  ) => PluginHookToolResultPersistResult | void;
  session_start: (
    event: PluginHookSessionStartEvent,
    ctx: PluginHookSessionContext,
  ) => Promise<void> | void;
  session_end: (
    event: PluginHookSessionEndEvent,
    ctx: PluginHookSessionContext,
  ) => Promise<void> | void;
  gateway_start: (
    event: PluginHookGatewayStartEvent,
    ctx: PluginHookGatewayContext,
  ) => Promise<void> | void;
  gateway_stop: (
    event: PluginHookGatewayStopEvent,
    ctx: PluginHookGatewayContext,
  ) => Promise<void> | void;
};

export type PluginHookRegistration<K extends PluginHookName = PluginHookName> = {
  pluginId: string;
  hookName: K;
  handler: PluginHookHandlerMap[K];
  priority?: number;
  timeoutMs?: number;
  mode?: PluginHookExecutionMode;
  onTimeout?: PluginHookTimeoutMode;
  retry?: PluginHookRetryPolicy;
  maxConcurrency?: number;
  scope?: PluginHookScope;
  condition?: (
    event: Parameters<PluginHookHandlerMap[K]>[0],
    ctx: Parameters<PluginHookHandlerMap[K]>[1],
  ) => boolean | Promise<boolean>;
  source: string;
};
