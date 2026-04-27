import type { AgentToolResultMiddleware, AgentToolResultMiddlewareOptions, AgentToolResultMiddlewareRuntime } from "./agent-tool-result-middleware-types.js";
export declare const AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES: ["pi", "codex"];
export declare function normalizeAgentToolResultMiddlewareRuntimes(options?: AgentToolResultMiddlewareOptions): AgentToolResultMiddlewareRuntime[];
/** @deprecated Use normalizeAgentToolResultMiddlewareRuntimes. */
export declare const normalizeAgentToolResultMiddlewareHarnesses: typeof normalizeAgentToolResultMiddlewareRuntimes;
export declare function normalizeAgentToolResultMiddlewareRuntimeIds(runtimes: readonly string[] | undefined): AgentToolResultMiddlewareRuntime[];
export declare function listAgentToolResultMiddlewares(runtime: AgentToolResultMiddlewareRuntime): AgentToolResultMiddleware[];
