import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { mergeToolUsage, type ToolUsageRow } from "./tool-usage.js";

export type RunToolUsageRecorder = {
  record: (toolId: string) => void;
  flush: () => Promise<void>;
  settle: () => Promise<void>;
};

const activeRecorders = new Map<string, Set<(generation: number) => void>>();

/** Reset publishes its committed generation before any later completion can add a count. */
export function discardPendingAgentToolUsage(agentId: string, generation: number): void {
  for (const discard of activeRecorders.get(agentId) ?? []) {
    discard(generation);
  }
}

export function isToolUsageRecordingEnabled(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
}): boolean {
  return (
    params.config?.agents?.defaults?.experimental?.usageRankedToolIndex === true &&
    !isIncognitoSessionKey(params.sessionKey)
  );
}

/** One attempt owns its counts; completion never waits for storage or loads a catalog. */
export async function createRunToolUsageRecorder(params: {
  agentId: string;
  runId: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  log: { warn: (message: string) => void };
  now?: () => number;
}): Promise<RunToolUsageRecorder | undefined> {
  if (!isToolUsageRecordingEnabled(params)) {
    return undefined;
  }
  const now = params.now ?? Date.now;
  let storage: typeof import("../config/sessions/tool-usage.js");
  let generation: number;
  try {
    storage = await import("../config/sessions/tool-usage.js");
    ({ generation } = await storage.beginAgentToolUsageRecording({
      agentId: params.agentId,
      runId: params.runId,
      config: params.config,
      now: now(),
    }));
  } catch (error) {
    params.log.warn(`tool usage recording unavailable: ${String(error)}`);
    return undefined;
  }
  const pending = new Map<string, ToolUsageRow>();
  let closed = false;
  let flushRequested = false;
  let inFlight: Promise<void> | undefined;
  const discard = (nextGeneration: number) => {
    generation = nextGeneration;
    pending.clear();
    flushRequested = false;
  };
  const recorders = activeRecorders.get(params.agentId) ?? new Set<(generation: number) => void>();
  activeRecorders.set(params.agentId, recorders);
  recorders.add(discard);

  const flush = (): Promise<void> => {
    flushRequested = true;
    if (inFlight) {
      return inFlight;
    }
    if (pending.size === 0) {
      flushRequested = false;
      return Promise.resolve();
    }
    // Slow storage retains at most one submitted batch and one coalesced map,
    // not an unbounded promise/row queue for every completed model turn.
    inFlight = (async () => {
      while (flushRequested && pending.size > 0) {
        flushRequested = false;
        const rows = [...pending.values()];
        pending.clear();
        try {
          await storage.flushAgentToolUsage({
            agentId: params.agentId,
            runId: params.runId,
            config: params.config,
            rows,
            generation,
            now: now(),
          });
        } catch (error) {
          // Ranking is a hint: drop this batch rather than retrying an uncertain write.
          params.log.warn(`tool usage flush failed: ${String(error)}`);
        }
      }
    })().finally(() => {
      inFlight = undefined;
      // A completed turn can request a flush between the drain's final check
      // and this promise settlement; keep that request in the same drain chain.
      if (flushRequested && pending.size > 0) {
        return flush();
      }
      return undefined;
    });
    return inFlight;
  };
  return {
    record(toolId) {
      if (closed) {
        return;
      }
      const contribution = { toolId, score: 1, updatedAt: now() };
      const previous = pending.get(toolId);
      pending.set(toolId, previous ? mergeToolUsage(previous, contribution) : contribution);
    },
    flush,
    async settle() {
      if (closed) {
        await inFlight;
        return;
      }
      closed = true;
      try {
        await flush();
      } finally {
        recorders.delete(discard);
        if (recorders.size === 0) {
          activeRecorders.delete(params.agentId);
        }
      }
    },
  };
}
