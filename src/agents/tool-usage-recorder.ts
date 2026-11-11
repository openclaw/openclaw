import type { OpenClawConfig } from "../config/types.openclaw.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { mergeToolUsage, type ToolUsageRow } from "./tool-usage.js";

export type RunToolUsageRecorder = {
  record: (toolId: string) => void;
  flush: () => Promise<void>;
  settle: () => Promise<void>;
};

type ActiveRecorder = { discard: (generation: number) => void; admission: Promise<void> };
const activeRecorders = new Map<string, Set<ActiveRecorder>>();

/** Reset publishes its committed generation before any later completion can add a count. */
export function discardPendingAgentToolUsage(agentId: string, generation: number): void {
  for (const recorder of activeRecorders.get(agentId) ?? []) {
    recorder.discard(generation);
  }
}

/** Import must observe live-run receipts even when their startup is still in flight. */
export async function settlePendingAgentToolUsageAdmissions(agentId: string): Promise<void> {
  await Promise.all(
    [...(activeRecorders.get(agentId) ?? [])].map((recorder) => recorder.admission),
  );
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
export function createRunToolUsageRecorder(params: {
  agentId: string;
  runId: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  log: { warn: (message: string) => void };
  now?: () => number;
}): RunToolUsageRecorder | undefined {
  if (!isToolUsageRecordingEnabled(params)) {
    return undefined;
  }
  const now = params.now ?? Date.now;
  const startedAt = now();
  let storage: typeof import("../config/sessions/tool-usage.js") | undefined;
  let generation: number | undefined;
  const pending = new Map<string, ToolUsageRow>();
  let closed = false;
  let unavailable = false;
  let flushRequested = false;
  let inFlight: Promise<void> | undefined;
  const discard = (nextGeneration: number) => {
    generation = nextGeneration;
    pending.clear();
    flushRequested = false;
  };
  const admission = trackAsyncWork(async () => {
    const backend = await import("../config/sessions/tool-usage.js");
    const admitted = await backend.beginAgentToolUsageRecording({
      agentId: params.agentId,
      runId: params.runId,
      config: params.config,
      now: startedAt,
    });
    // A reset published while admission awaited storage owns the newer generation.
    generation ??= admitted.generation;
    storage = backend;
  }).catch((error: unknown) => {
    unavailable = true;
    pending.clear();
    params.log.warn(`tool usage recording unavailable: ${String(error)}`);
  });
  const recorders = activeRecorders.get(params.agentId) ?? new Set<ActiveRecorder>();
  activeRecorders.set(params.agentId, recorders);
  const active = { discard, admission };
  recorders.add(active);

  const flush = (): Promise<void> => {
    flushRequested = true;
    if (inFlight) {
      return inFlight;
    }
    if (pending.size === 0) {
      flushRequested = false;
      return admission;
    }
    // Slow storage retains at most one submitted batch and one coalesced map,
    // not an unbounded promise/row queue for every completed model turn.
    inFlight = trackAsyncWork(async () => {
      try {
        if (!storage) {
          await admission;
        }
        if (unavailable || !storage || generation === undefined) {
          return;
        }
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
      } finally {
        // Release the drain inside tracked work, before its owner can close.
        inFlight = undefined;
      }
    }).catch((error: unknown) => {
      inFlight = undefined;
      pending.clear();
      flushRequested = false;
      params.log.warn(`tool usage flush failed: ${String(error)}`);
    });
    return inFlight;
  };
  return {
    record(toolId) {
      if (closed || unavailable) {
        return;
      }
      const contribution = { toolId, score: 1, updatedAt: now() };
      const previous = pending.get(toolId);
      pending.set(toolId, previous ? mergeToolUsage(previous, contribution) : contribution);
    },
    flush,
    async settle() {
      if (closed) {
        await (inFlight ?? admission);
        return;
      }
      closed = true;
      try {
        await flush();
      } finally {
        recorders.delete(active);
        if (recorders.size === 0) {
          activeRecorders.delete(params.agentId);
        }
      }
    },
  };
}
