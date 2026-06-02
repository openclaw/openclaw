import type { PluginRuntimeChannel } from "./types-channel.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";

export type { RuntimeLogger };

export type SubagentRunParams = {
  /** Session key to route the subagent turn into. */
  sessionKey: string;
  /** User message sent to the subagent. */
  message: string;
  /** Optional provider override for this subagent turn. */
  provider?: string;
  /** Optional model override for this subagent turn. */
  model?: string;
  /** Extra system prompt appended to the subagent instructions. */
  extraSystemPrompt?: string;
  /** Optional execution lane used by callers that separate subagent work queues. */
  lane?: string;
  /** Request a lighter context package for the subagent turn. */
  lightContext?: boolean;
  /** Whether the subagent result should be delivered through normal channel output. */
  deliver?: boolean;
  /** Idempotency key for retrying a subagent run request. */
  idempotencyKey?: string;
};

export type SubagentRunResult = {
  /** Stable run id used with waitForRun. */
  runId: string;
};

export type SubagentWaitParams = {
  /** Run id returned by subagent.run. */
  runId: string;
  /** Optional maximum wait time before returning timeout. */
  timeoutMs?: number;
};

export type SubagentWaitResult = {
  status: "ok" | "error" | "timeout";
  error?: string;
};

export type SubagentGetSessionMessagesParams = {
  sessionKey: string;
  limit?: number;
};

export type SubagentGetSessionMessagesResult = {
  messages: unknown[];
};

/** @deprecated Use SubagentGetSessionMessagesParams. */
export type SubagentGetSessionParams = SubagentGetSessionMessagesParams;

/** @deprecated Use SubagentGetSessionMessagesResult. */
export type SubagentGetSessionResult = SubagentGetSessionMessagesResult;

export type SubagentDeleteSessionParams = {
  sessionKey: string;
  deleteTranscript?: boolean;
};

export type RuntimeNodeListParams = {
  connected?: boolean;
};

export type RuntimeNodeListResult = {
  nodes: Array<{
    nodeId: string;
    displayName?: string;
    remoteIp?: string;
    connected?: boolean;
    caps?: string[];
    commands?: string[];
  }>;
};

export type RuntimeNodeInvokeParams = {
  /** Runtime node id returned by nodes.list. */
  nodeId: string;
  /** Command exposed by the selected runtime node. */
  command: string;
  /** Command-specific payload passed through to the node. */
  params?: unknown;
  /** Optional node invocation timeout. */
  timeoutMs?: number;
  /** Idempotency key for retrying a node command request. */
  idempotencyKey?: string;
};

/** Trusted in-process runtime surface injected into native plugins. */
export type PluginRuntime = PluginRuntimeCore & {
  subagent: {
    run: (params: SubagentRunParams) => Promise<SubagentRunResult>;
    waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
    getSessionMessages: (
      params: SubagentGetSessionMessagesParams,
    ) => Promise<SubagentGetSessionMessagesResult>;
    /** @deprecated Use getSessionMessages. */
    getSession: (params: SubagentGetSessionParams) => Promise<SubagentGetSessionResult>;
    deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
  };
  nodes: {
    list: (params?: RuntimeNodeListParams) => Promise<RuntimeNodeListResult>;
    invoke: (params: RuntimeNodeInvokeParams) => Promise<unknown>;
  };
  channel: PluginRuntimeChannel;
};

export type CreatePluginRuntimeOptions = {
  /** Override subagent runtime implementation, mainly for tests and gateway-bound hosts. */
  subagent?: PluginRuntime["subagent"];
  /** Override remote node runtime implementation. */
  nodes?: PluginRuntime["nodes"];
  /** Allow subagent calls to bind through the active gateway request scope when present. */
  allowGatewaySubagentBinding?: boolean;
};
