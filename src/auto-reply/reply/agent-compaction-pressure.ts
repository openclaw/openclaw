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
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";

function resolveMemoryFlushContextWindowTokens(params: {
  modelId: string;
  agentCfgContextTokens?: number;
}): number {
  return params.agentCfgContextTokens ?? 128_000;
}

/**
 * Estimate current context tokens from the session transcript.
 * Uses chars/4 heuristic (same as upstream compaction).
 * Reads only kept messages (respects compaction markers).
 */
function estimateSessionTokensFromTranscript(entry: SessionEntry): number | undefined {
  const sessionId = (entry as Record<string, unknown>).sessionId as string | undefined;
  if (!sessionId) return undefined;
  try {
    // Dynamic require to avoid circular imports
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readSessionMessages } = require("../../gateway/session-utils.fs.js");
    const messages = readSessionMessages(
      sessionId,
      undefined,
      (entry as Record<string, unknown>).sessionFile as string | undefined,
    );
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    let total = 0;
    for (const msg of messages) total += estimateTokens(msg);
    return total > 0 ? total : undefined;
  } catch (_e) {
    return undefined;
  }
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

  const contextWindowTokens =
    (entry as Record<string, unknown>).contextTokens as number | undefined ??
    resolveMemoryFlushContextWindowTokens({
      modelId: params.defaultModel,
      agentCfgContextTokens: params.agentCfgContextTokens,
    });

  const totalTokens = estimateSessionTokensFromTranscript(entry);

  logVerbose(
    `preflightCompaction check: sessionKey=${params.sessionKey} ` +
    `tokenCount=${totalTokens} contextWindow=${contextWindowTokens} ` +
    `threshold=${contextWindowTokens * 0.85} ` +
    `estimated=true method=transcript`,
  );

  const signal = computeContextPressure({
    totalTokens: totalTokens ?? undefined,
    contextWindowTokens,
  });

  if (signal && params.sessionKey) {
    const message = formatContextPressureMessage(signal);
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
