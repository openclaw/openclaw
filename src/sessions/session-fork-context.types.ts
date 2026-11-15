import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type { LlmBoundaryOptions } from "../agents/embedded-agent-runner/run/attempt-llm-boundary.types.js";
import type { Context, Model } from "../llm/types.js";

/** An attempt's last post-hook provider request body; session forks replay it. */
export type PreparedProviderRequest = { model: Model; body: Record<string, unknown> };

/** Model context a live attempt lends to a session fork while it owns the session. */
export type SessionForkContextSnapshot = {
  model: Model;
  /** The attempt's provider prompt-cache key, so the fork reads the parent's cached prefix. */
  promptCacheKey?: string;
  systemPrompt: string;
  tools: Context["tools"];
  messages: AgentMessage[];
  projectMessages?: (messages: AgentMessage[]) => AgentMessage[];
  sessionVersion?: number;
  boundary?: LlmBoundaryOptions;
  blockImages?: boolean;
  /** The attempt's last provider request, which the fork replays ahead of its own suffix. */
  preparedRequest?: PreparedProviderRequest;
};
