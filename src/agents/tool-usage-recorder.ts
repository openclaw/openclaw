import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import type { AgentToolUsageAppend } from "../config/sessions/tool-usage.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { mergeToolUsage, type ToolUsageRow } from "./tool-usage.js";

export type RunToolUsageRecorder = {
  record: (toolId: string) => void;
  bindTranscript: (database?: Readonly<OpenClawAgentDatabaseOptions>) => Promise<void> | void;
  takeAppend: () => AgentToolUsageAppend | undefined;
  committed: (generation: number) => void;
  settle: () => Promise<void>;
};

type ActiveRecorder = { discard: (generation: number) => void; runId: string };
const activeRecorders = new Map<string, Set<ActiveRecorder>>();

/** Reset publishes its committed generation before any later completion can add a count. */
export function discardPendingAgentToolUsage(agentId: string, generation: number): void {
  for (const recorder of activeRecorders.get(agentId) ?? []) {
    recorder.discard(generation);
  }
}

/** An import also excludes admitted runs whose first transcript commit is still pending. */
export function captureActiveAgentToolUsageRuns(agentId: string): string[] {
  return [...(activeRecorders.get(agentId) ?? [])].map((recorder) => recorder.runId);
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

/** Successful calls only update a run-local map; the transcript owner commits its batches. */
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
  const agentId = normalizeAgentId(params.agentId);
  const now = params.now ?? Date.now;
  const startedAt = now();
  const pending = new Map<string, ToolUsageRow>();
  let generation: number | undefined;
  let coCommit = false;
  let closed = false;
  let unavailable = false;
  let settlement: Promise<void> | undefined;
  let env: NodeJS.ProcessEnv | undefined;
  let storage: typeof import("../config/sessions/tool-usage.js") | undefined;
  const recorders = activeRecorders.get(agentId) ?? new Set<ActiveRecorder>();
  activeRecorders.set(agentId, recorders);
  const active: ActiveRecorder = {
    runId: params.runId,
    discard(nextGeneration) {
      generation = nextGeneration;
      pending.clear();
    },
  };
  recorders.add(active);
  return {
    bindTranscript(database) {
      env = database?.env;
      coCommit =
        database !== undefined &&
        database.agentId === agentId &&
        resolveOpenClawAgentSqlitePath(database) ===
          resolveOpenClawAgentSqlitePath({ agentId, env: database.env });
      if (coCommit) {
        return undefined;
      }
      // A foreign transcript store cannot write this agent's counters. Read its
      // reset fence before execution, then use the existing retained settle writer.
      return trackAsyncWork(async () => {
        try {
          storage = await import("../config/sessions/tool-usage.js");
          const state = await storage.readAgentToolUsageStatus({
            agentId,
            config: params.config,
            now: startedAt,
            ...(env ? { env } : {}),
          });
          generation ??= state.generation;
        } catch (error) {
          unavailable = true;
          pending.clear();
          params.log.warn(`tool usage recording unavailable: ${String(error)}`);
        }
      });
    },
    record(toolId) {
      if (closed || unavailable) {
        return;
      }
      const contribution = { toolId, score: 1, updatedAt: now() };
      const previous = pending.get(toolId);
      pending.set(toolId, previous ? mergeToolUsage(previous, contribution) : contribution);
    },
    takeAppend() {
      if (!coCommit || closed || unavailable) {
        return undefined;
      }
      if (generation === undefined) {
        return { kind: "begin", runId: params.runId, now: startedAt };
      }
      if (pending.size === 0) {
        return undefined;
      }
      const rows = [...pending.values()];
      pending.clear();
      return { kind: "flush", runId: params.runId, generation, rows, now: now() };
    },
    committed(committedGeneration) {
      // A reset published during the append owns the newer generation.
      generation ??= committedGeneration;
    },
    settle() {
      if (settlement) {
        return settlement;
      }
      closed = true;
      settlement = trackAsyncWork(async () => {
        try {
          if (unavailable || (coCommit && pending.size === 0)) {
            return;
          }
          if (generation === undefined) {
            if (pending.size > 0) {
              params.log.warn("tool usage counts dropped without an admitted transcript");
            }
            return;
          }
          const batchGeneration = generation;
          const rows = [...pending.values()];
          pending.clear();
          // Late completions and noncanonical transcript stores retain the existing
          // settlement writer. Ordinary appends already consumed their batches.
          storage ??= await import("../config/sessions/tool-usage.js");
          await storage.flushAgentToolUsage({
            agentId,
            runId: params.runId,
            config: params.config,
            rows,
            generation: batchGeneration,
            startedAt,
            now: now(),
            ...(env ? { env } : {}),
          });
        } catch (error) {
          // A failed or uncertain write never authorizes replay of a usage delta.
          params.log.warn(`tool usage flush failed: ${String(error)}`);
        } finally {
          pending.clear();
          recorders.delete(active);
          if (recorders.size === 0) {
            activeRecorders.delete(agentId);
          }
        }
      });
      return settlement;
    },
  };
}
