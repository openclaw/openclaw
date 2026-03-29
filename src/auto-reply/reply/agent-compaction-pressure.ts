/**
 * Agent-controlled compaction: check context pressure and inject a system event
 * signal instead of running a memory flush turn.
 *
 * Extracted to its own module to avoid circular import chains from
 * agent-runner-memory.ts's heavy transitive dependency graph.
 */
import {
  computeContextPressure,
  formatContextPressureMessage,
} from "../../agents/context-pressure.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";

function resolveMemoryFlushContextWindowTokens(params: {
  modelId: string;
  agentCfgContextTokens?: number;
}): number {
  return params.agentCfgContextTokens ?? 128_000;
}

function resolveFreshSessionTotalTokens(entry: SessionEntry): number | undefined {
  if ("totalTokensFresh" in entry && entry.totalTokensFresh) {
    return (entry as { totalTokens?: number }).totalTokens;
  }
  return (entry as { totalTokens?: number }).totalTokens;
}

export function maybeInjectAgentCompactionPressureSignal(params: {
  cfg: OpenClawConfig;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
}): SessionEntry | undefined {
  const entry = params.sessionEntry;
  if (!entry) {
    return entry;
  }

  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    modelId: params.defaultModel,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });

  const totalTokens = resolveFreshSessionTotalTokens(entry);

  const signal = computeContextPressure({
    totalTokens: totalTokens ?? undefined,
    contextWindowTokens,
  });

  if (signal && params.sessionKey) {
    const message = formatContextPressureMessage(signal);
    // Use dynamic import to avoid circular dependency through system-events → delivery-context → channels/registry
    void import("../../infra/system-events.js").then(({ enqueueSystemEvent }) => {
      enqueueSystemEvent(message, { sessionKey: params.sessionKey! });
    });
    logVerbose(
      `agent-compaction pressure signal: sessionKey=${params.sessionKey} ` +
        `pressure=${signal.pressure} recommended=${signal.compactionRecommended}`,
    );
  }

  return entry;
}
