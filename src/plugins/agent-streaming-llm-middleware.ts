import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  AgentStreamingLlmMiddleware,
  AgentStreamingLlmMiddlewareContext,
  AgentStreamingLlmMiddlewareOptions,
  AgentStreamingLlmMiddlewareRuntime,
} from "./agent-streaming-llm-middleware-types.js";
import { getGlobalPluginRegistry } from "./hook-runner-global.js";

const log = createSubsystemLogger("plugins/agent-streaming-llm-middleware");

export const AGENT_STREAMING_LLM_MIDDLEWARE_RUNTIMES = [
  "pi",
] as const satisfies AgentStreamingLlmMiddlewareRuntime[];

const AGENT_STREAMING_LLM_MIDDLEWARE_RUNTIME_SET = new Set<string>(
  AGENT_STREAMING_LLM_MIDDLEWARE_RUNTIMES,
);

function normalizeAgentStreamingLlmMiddlewareRuntime(
  runtime: string,
): AgentStreamingLlmMiddlewareRuntime | undefined {
  const normalized = runtime.trim().toLowerCase();
  return AGENT_STREAMING_LLM_MIDDLEWARE_RUNTIME_SET.has(normalized)
    ? (normalized as AgentStreamingLlmMiddlewareRuntime)
    : undefined;
}

export function normalizeAgentStreamingLlmMiddlewareRuntimes(
  options?: AgentStreamingLlmMiddlewareOptions,
): AgentStreamingLlmMiddlewareRuntime[] {
  const requested = options?.runtimes;
  if (!requested || requested.length === 0) {
    return [...AGENT_STREAMING_LLM_MIDDLEWARE_RUNTIMES];
  }
  const normalized: AgentStreamingLlmMiddlewareRuntime[] = [];
  for (const runtime of requested) {
    const value = normalizeAgentStreamingLlmMiddlewareRuntime(runtime);
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

export function normalizeAgentStreamingLlmMiddlewareRuntimeIds(
  runtimes: readonly string[] | undefined,
): AgentStreamingLlmMiddlewareRuntime[] {
  const normalized: AgentStreamingLlmMiddlewareRuntime[] = [];
  for (const runtime of runtimes ?? []) {
    const value = normalizeAgentStreamingLlmMiddlewareRuntime(runtime);
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

function listAgentStreamingLlmMiddlewares(
  runtime: AgentStreamingLlmMiddlewareRuntime,
): Array<{ handler: AgentStreamingLlmMiddleware; priority: number; pluginId: string }> {
  return (
    getGlobalPluginRegistry()
      ?.agentStreamingLlmMiddlewares?.filter((entry) => entry.runtimes.includes(runtime))
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

export function wrapStreamFnWithAgentStreamingLlmMiddlewares(
  params: Omit<AgentStreamingLlmMiddlewareContext, "runtime"> & {
    runtime?: AgentStreamingLlmMiddlewareRuntime;
  },
): StreamFn {
  const runtime = params.runtime ?? "pi";
  let current = params.streamFn;

  for (const entry of listAgentStreamingLlmMiddlewares(runtime)) {
    try {
      const next = entry.handler({
        ...params,
        runtime,
        streamFn: current,
      });
      if (next) {
        current = next;
      }
    } catch (error) {
      log.warn(
        `agent streaming LLM middleware failed: plugin=${entry.pluginId} error=${String(error)}`,
      );
    }
  }

  return current;
}
