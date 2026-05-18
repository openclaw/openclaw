export type AgentToolCallMiddlewareRuntime = "pi";

export type AgentToolCallMiddlewareContext = {
  runtime: AgentToolCallMiddlewareRuntime;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
  params: unknown;
  execute: (params: unknown) => Promise<unknown>;
};

export type AgentToolCallMiddleware = (
  ctx: AgentToolCallMiddlewareContext,
) => Promise<unknown> | unknown;

export type AgentToolCallMiddlewareOptions = {
  runtimes?: AgentToolCallMiddlewareRuntime[];
  priority?: number;
};
