import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type { LlmBoundaryOptions } from "../agents/embedded-agent-runner/run/attempt-llm-boundary.types.js";
import type { Context, Model } from "../llm/types.js";

/** Model context a live attempt lends to a session fork while it owns the session. */
export type SessionForkContextSnapshot = {
  model: Model;
  /** The attempt's provider prompt-cache routing key, when it sends one. */
  promptCacheKey?: string;
  systemPrompt: string;
  tools: Context["tools"];
  messages: AgentMessage[];
  projectMessages?: (messages: AgentMessage[]) => AgentMessage[];
  sessionVersion?: number;
  boundary?: LlmBoundaryOptions;
  blockImages?: boolean;
};
