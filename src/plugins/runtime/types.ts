import type {
  DeliverOutboundPayloadsParams,
  OutboundDeliveryResult,
} from "../../infra/outbound/deliver.js";
import type { PluginRuntimeChannel } from "./types-channel.js";
import type { PluginRuntimeCore, RuntimeLogger } from "./types-core.js";

export type { RuntimeLogger };

// ── Plugin-safe outbound delivery params (internal fields stripped) ──

type PluginDeliverOutboundParams = Omit<
  DeliverOutboundPayloadsParams,
  "skipQueue" | "mirror" | "session" | "deps"
>;

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
  };
  outbound: {
    /** Send payloads through the standard outbound delivery pipeline (chunking, hooks, queue). */
    deliverOutboundPayloads: (
      params: PluginDeliverOutboundParams,
    ) => Promise<OutboundDeliveryResult[]>;
  };
  channel: PluginRuntimeChannel;
};
