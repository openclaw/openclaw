import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  AgentToolCallMiddleware,
  AgentToolCallMiddlewareContext,
  AgentToolCallMiddlewareOptions,
  AgentToolCallMiddlewareRuntime,
} from "./agent-tool-call-middleware-types.js";
import { getGlobalPluginRegistry } from "./hook-runner-global.js";

const log = createSubsystemLogger("plugins/agent-tool-call-middleware");

export const AGENT_TOOL_CALL_MIDDLEWARE_RUNTIMES = [
  "pi",
] as const satisfies AgentToolCallMiddlewareRuntime[];

const AGENT_TOOL_CALL_MIDDLEWARE_RUNTIME_SET = new Set<string>(AGENT_TOOL_CALL_MIDDLEWARE_RUNTIMES);

function normalizeAgentToolCallMiddlewareRuntime(
  runtime: string,
): AgentToolCallMiddlewareRuntime | undefined {
  const normalized = runtime.trim().toLowerCase();
  return AGENT_TOOL_CALL_MIDDLEWARE_RUNTIME_SET.has(normalized)
    ? (normalized as AgentToolCallMiddlewareRuntime)
    : undefined;
}

export function normalizeAgentToolCallMiddlewareRuntimes(
  options?: AgentToolCallMiddlewareOptions,
): AgentToolCallMiddlewareRuntime[] {
  const requested = options?.runtimes;
  if (!requested || requested.length === 0) {
    return [...AGENT_TOOL_CALL_MIDDLEWARE_RUNTIMES];
  }
  const normalized: AgentToolCallMiddlewareRuntime[] = [];
  for (const runtime of requested) {
    const value = normalizeAgentToolCallMiddlewareRuntime(runtime);
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

export function normalizeAgentToolCallMiddlewareRuntimeIds(
  runtimes: readonly string[] | undefined,
): AgentToolCallMiddlewareRuntime[] {
  const normalized: AgentToolCallMiddlewareRuntime[] = [];
  for (const runtime of runtimes ?? []) {
    const value = normalizeAgentToolCallMiddlewareRuntime(runtime);
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

function listAgentToolCallMiddlewares(
  runtime: AgentToolCallMiddlewareRuntime,
): Array<{ handler: AgentToolCallMiddleware; priority: number; pluginId: string }> {
  return (
    getGlobalPluginRegistry()
      ?.agentToolCallMiddlewares?.filter((entry) => entry.runtimes.includes(runtime))
      .map((entry) => ({
        handler: entry.handler,
        priority: entry.priority ?? 0,
        pluginId: entry.pluginId,
      }))
      .sort((left, right) => {
        const priorityDelta = left.priority - right.priority;
        return priorityDelta === 0 ? left.pluginId.localeCompare(right.pluginId) : priorityDelta;
      }) ?? []
  );
}

export async function executeToolWithAgentToolCallMiddlewares(
  params: Omit<AgentToolCallMiddlewareContext, "runtime"> & {
    runtime?: AgentToolCallMiddlewareRuntime;
  },
): Promise<unknown> {
  const runtime = params.runtime ?? "pi";
  let execute = params.execute;

  for (const entry of listAgentToolCallMiddlewares(runtime)) {
    const priorExecute = execute;
    execute = async (nextParams) => {
      const next = async (effectiveParams: unknown) => {
        return await priorExecute(effectiveParams);
      };

      try {
        return await entry.handler({
          ...params,
          runtime,
          params: nextParams,
          execute: next,
        });
      } catch (error) {
        log.warn(
          `agent tool-call middleware failed: plugin=${entry.pluginId} error=${String(error)}`,
        );
        throw error;
      }
    };
  }

  return await execute(params.params);
}
