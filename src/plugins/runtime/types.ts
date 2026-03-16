import type { ClientToolDefinition } from "../../agents/pi-embedded-runner/run/params.js";
import type { AgentStreamParams } from "../../commands/agent/types.js";
import type { PluginRuntimeChannel } from "./types-channel.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";

export type { RuntimeLogger };

// ── Subagent runtime types ──────────────────────────────────────────

export type SubagentRunParams = {
  sessionKey: string;
  message: string;
  extraSystemPrompt?: string;
  lane?: string;
  deliver?: boolean;
  idempotencyKey?: string;
  clientTools?: ClientToolDefinition[];
  disableTools?: boolean;
  streamParams?: AgentStreamParams;
};

export type SubagentRunResult = {
  runId: string;
};

export type SubagentEnqueueParams = SubagentRunParams;

export type SubagentEnqueueResult = SubagentRunResult;

export type SubagentWaitParams = {
  runId: string;
  timeoutMs?: number;
};

export type SubagentWaitResult = {
  status: "ok" | "error" | "timeout";
  error?: string;
  stopReason?: string;
  pendingToolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
};

export type SubagentAbortParams = {
  runId: string;
  sessionKey?: string;
};

export type SubagentAbortResult = {
  aborted: boolean;
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
    enqueue: (params: SubagentEnqueueParams) => Promise<SubagentEnqueueResult>;
    abort: (params: SubagentAbortParams) => Promise<SubagentAbortResult>;
    waitForRun: (params: SubagentWaitParams) => Promise<SubagentWaitResult>;
    getSessionMessages: (
      params: SubagentGetSessionMessagesParams,
    ) => Promise<SubagentGetSessionMessagesResult>;
    /** @deprecated Use getSessionMessages. */
    getSession: (params: SubagentGetSessionParams) => Promise<SubagentGetSessionResult>;
    deleteSession: (params: SubagentDeleteSessionParams) => Promise<void>;
  };
  channel: PluginRuntimeChannel;
};
