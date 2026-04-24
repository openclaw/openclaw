import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareHarness,
  AgentToolResultMiddlewareOptions,
} from "./agent-tool-result-middleware-types.js";
import { getActivePluginRegistry } from "./runtime.js";

export const AGENT_TOOL_RESULT_MIDDLEWARE_HARNESSES = [
  "pi",
  "codex-app-server",
] as const satisfies AgentToolResultMiddlewareHarness[];

const AGENT_TOOL_RESULT_MIDDLEWARE_HARNESS_SET = new Set<string>(
  AGENT_TOOL_RESULT_MIDDLEWARE_HARNESSES,
);

export function normalizeAgentToolResultMiddlewareHarnesses(
  options?: AgentToolResultMiddlewareOptions,
): AgentToolResultMiddlewareHarness[] {
  const requested = options?.harnesses;
  if (!requested || requested.length === 0) {
    return [...AGENT_TOOL_RESULT_MIDDLEWARE_HARNESSES];
  }
  const normalized: AgentToolResultMiddlewareHarness[] = [];
  for (const harness of requested) {
    if (!AGENT_TOOL_RESULT_MIDDLEWARE_HARNESS_SET.has(harness)) {
      continue;
    }
    if (!normalized.includes(harness)) {
      normalized.push(harness);
    }
  }
  return normalized;
}

export function listAgentToolResultMiddlewares(
  harness: AgentToolResultMiddlewareHarness,
): AgentToolResultMiddleware[] {
  return (
    getActivePluginRegistry()
      ?.agentToolResultMiddlewares?.filter((entry) => entry.harnesses.includes(harness))
      .map((entry) => entry.handler) ?? []
  );
}
