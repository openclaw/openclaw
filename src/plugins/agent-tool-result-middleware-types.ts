import type { AgentToolResult } from "../agents/runtime/index.js";

export type OpenClawAgentToolResult<TResult = unknown> = AgentToolResult<TResult>;

export type AgentToolResultMiddlewareRuntime = "openclaw" | "codex";
/** @deprecated Use "openclaw". */
export type AgentToolResultMiddlewareLegacyRuntime = "pi";
/** @deprecated Use AgentToolResultMiddlewareRuntime. */
export type AgentToolResultMiddlewareHarness =
  | AgentToolResultMiddlewareRuntime
  | AgentToolResultMiddlewareLegacyRuntime
  | "codex-app-server";

export type AgentToolResultMiddlewareEvent = {
  threadId?: string;
  turnId?: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  cwd?: string;
  isError?: boolean;
  result: OpenClawAgentToolResult;
};

export type AgentToolResultMiddlewareContext = {
  runtime: AgentToolResultMiddlewareRuntime;
  /** @deprecated Use runtime. */
  harness?: AgentToolResultMiddlewareRuntime;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
};

export type AgentToolResultMiddlewareResult = {
  result: OpenClawAgentToolResult;
};

export type AgentToolResultMiddleware = (
  event: AgentToolResultMiddlewareEvent,
  ctx: AgentToolResultMiddlewareContext,
) => Promise<AgentToolResultMiddlewareResult | void> | AgentToolResultMiddlewareResult | void;

export type AgentToolResultMiddlewareOptions = {
  runtimes?: Array<AgentToolResultMiddlewareRuntime | AgentToolResultMiddlewareLegacyRuntime>;
  /** @deprecated Use runtimes. */
  harnesses?: AgentToolResultMiddlewareHarness[];
};
