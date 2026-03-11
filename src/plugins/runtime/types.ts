import type { PluginRuntimeChannel } from "./types-channel.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";

export type { RuntimeLogger };

// ── Agent invocation types (used by plugin-sdk and runtime) ───────────

export type PluginAgentInvokeRuntimeParams = {
  agentId: string;
  messages?: Array<{ role: string; content: string }>;
  sessionKey?: string;
  timeoutSeconds?: number;
  stream?: boolean;
  prompt?: string;
  idempotencyKey?: string;
};

export type PluginAgentInvokeReplyTagMetadata = {
  hasReplyTag: boolean;
  replyToId?: string;
  replyToCurrent: boolean;
};

export type PluginAgentInvokeRuntimeResult = {
  success: boolean;
  error?: string;
  content?: string;
  messages?: unknown[];
  sessionKey?: string;
  replyTag?: PluginAgentInvokeReplyTagMetadata;
};

// ── Subagent runtime types ──────────────────────────────────────────

export type SubagentRunParams = {
  sessionKey: string;
  message: string;
  extraSystemPrompt?: string;
  lane?: string;
  deliver?: boolean;
  idempotencyKey?: string;
};

export type SubagentRunResult = {
  runId: string;
};

export type SubagentWaitParams = {
  runId: string;
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
    /** Invoke an agent directly (non-streaming). */
    invokeAgent: (
      params: PluginAgentInvokeRuntimeParams,
    ) => Promise<PluginAgentInvokeRuntimeResult>;
    /** Invoke an agent with streaming response. */
    invokeAgentStream: (
      params: PluginAgentInvokeRuntimeParams,
    ) => Promise<ReadableStream<Uint8Array>>;
  };
  channel: PluginRuntimeChannel;
};
