import type { PluginRuntimeChannel } from "./types-channel.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";

export type { RuntimeLogger };

// ── Subagent runtime types ──────────────────────────────────────────

export type SubagentRunParams = {
  sessionKey: string;
  message: string;
  provider?: string;
  model?: string;
  extraSystemPrompt?: string;
  lane?: string;
  deliver?: boolean;
  idempotencyKey?: string;
  // clientTools, disableTools, and streamParams are intentionally omitted —
  // AgentParamsSchema does not include these fields yet, so forwarding them
  // would cause validation failure at the gateway.
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

/** Trusted in-process runtime surface injected into native plugins. */
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
