import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";

export type AgentStreamingLlmMiddlewareRuntime = "pi";

export type AgentStreamingLlmMiddlewareContext = {
  runtime: AgentStreamingLlmMiddlewareRuntime;
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  streamFn: StreamFn;
};

export type AgentStreamingLlmMiddleware = (
  ctx: AgentStreamingLlmMiddlewareContext,
) => StreamFn | null | undefined;

export type AgentStreamingLlmMiddlewareOptions = {
  runtimes?: AgentStreamingLlmMiddlewareRuntime[];
  priority?: number;
};
