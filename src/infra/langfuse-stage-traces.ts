/**
 * Langfuse stage-trace instrumentation for gateway agent runs.
 *
 * Sends startup-stage and prep-stage timing breakdowns to Langfuse Cloud as
 * structured traces, enabling historical trending and alerting on run
 * preparation latency.
 *
 * Designed to degrade silently: if the `langfuse` package is not installed or
 * the Langfuse host is unreachable, every public function no-ops.
 */

import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StageSummary {
  totalMs: number;
  stages: { name: string; durationMs: number; elapsedMs: number }[];
}

export interface StageTraceParams {
  runId: string;
  sessionId: string;
  agentId?: string;
  provider?: string;
  model?: string;
  gatewayPort?: number;
  /**
   * The Paperclip heartbeat run UUID, when this gateway run was dispatched by
   * Paperclip. Stored as Langfuse trace metadata so external tools (like the
   * agentos-smoke-test skill) can correlate Paperclip runs with their gateway
   * stage timings. Populated from the `PAPERCLIP_RUN_ID` env var by the
   * embedded runner; absent for non-Paperclip-driven runs.
   */
  paperclipRunId?: string;
  summary: StageSummary;
}

// ---------------------------------------------------------------------------
// Lazy Langfuse client (singleton)
// ---------------------------------------------------------------------------

type LangfuseClient = {
  trace(params: Record<string, unknown>): {
    span(params: Record<string, unknown>): { end(params?: Record<string, unknown>): void };
    update(params: Record<string, unknown>): void;
  };
  flushAsync(): Promise<unknown>;
  shutdownAsync(): Promise<unknown>;
};

let langfuseClient: LangfuseClient | null | undefined; // undefined = not yet attempted

function getLangfuse(): LangfuseClient | null {
  if (langfuseClient !== undefined) {
    return langfuseClient;
  }
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("langfuse");
    const LangfuseClass = mod.Langfuse ?? mod.default?.Langfuse ?? mod.default;
    if (!LangfuseClass) {
      langfuseClient = null;
      return null;
    }
    langfuseClient = new LangfuseClass({
      publicKey: "pk-lf-21787c36-fbe8-4527-8397-1666ed57801f",
      secretKey: "sk-lf-7c68c3ed-492a-430c-aac8-20fed8bdd144",
      baseUrl: "https://us.cloud.langfuse.com",
      // Avoid blocking the event loop on flush
      flushAt: 5,
      flushInterval: 10_000,
    }) as LangfuseClient;
    return langfuseClient;
  } catch {
    langfuseClient = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Correlation map — associates startup + prep traces for the same runId
// ---------------------------------------------------------------------------

interface PendingEntry {
  traceId: string;
  createdAt: number;
}

const TTL_MS = 120_000;
const pendingTraces = new Map<string, PendingEntry>();

/** Evict stale entries so the map doesn't grow unbounded. */
function evictStale(): void {
  const now = Date.now();
  for (const [key, entry] of pendingTraces) {
    if (now - entry.createdAt > TTL_MS) {
      pendingTraces.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Trace startup stages (workspace resolution, model selection, auth, etc.)
 * that occur in `run.ts` before dispatching the attempt.
 */
export function traceStartupStages(params: StageTraceParams): void {
  try {
    const lf = getLangfuse();
    if (!lf) {
      return;
    }
    evictStale();

    const trace = lf.trace({
      name: "agent-run",
      id: `${params.runId}:startup`,
      sessionId: params.sessionId,
      tags: ["agent-run", "gateway-stages"],
      metadata: {
        phase: "startup",
        runId: params.runId,
        sessionId: params.sessionId,
        agentId: params.agentId,
        provider: params.provider,
        model: params.model,
        startupTotalMs: params.summary.totalMs,
        gatewayPort: params.gatewayPort,
        ...(params.paperclipRunId ? { paperclipRunId: params.paperclipRunId } : {}),
      },
    });

    for (const stage of params.summary.stages) {
      const span = trace.span({
        name: stage.name,
        startTime: new Date(
          Date.now() - params.summary.totalMs + stage.elapsedMs - stage.durationMs,
        ),
        metadata: {
          durationMs: stage.durationMs,
          elapsedMs: stage.elapsedMs,
        },
      });
      span.end({
        endTime: new Date(Date.now() - params.summary.totalMs + stage.elapsedMs),
      });
    }

    trace.update({
      output: {
        totalMs: params.summary.totalMs,
        stageCount: params.summary.stages.length,
      },
    });

    // Store for correlation with prep trace
    pendingTraces.set(params.runId, {
      traceId: `${params.runId}:startup`,
      createdAt: Date.now(),
    });
  } catch {
    // Never let tracing break the gateway
  }
}

/**
 * Trace prep stages (session creation, resource loading, tool setup, etc.)
 * that occur in `attempt.ts` before the prompt call.
 */
export function tracePrepStages(params: StageTraceParams): void {
  try {
    const lf = getLangfuse();
    if (!lf) {
      return;
    }
    evictStale();

    const startupEntry = pendingTraces.get(params.runId);
    if (startupEntry) {
      pendingTraces.delete(params.runId);
    }

    const trace = lf.trace({
      name: "agent-run",
      id: `${params.runId}:prep`,
      sessionId: params.sessionId,
      tags: ["agent-run", "gateway-stages"],
      metadata: {
        phase: "prep",
        runId: params.runId,
        sessionId: params.sessionId,
        agentId: params.agentId,
        provider: params.provider,
        model: params.model,
        prepTotalMs: params.summary.totalMs,
        gatewayPort: params.gatewayPort,
        ...(startupEntry ? { correlatedStartupTraceId: startupEntry.traceId } : {}),
        ...(params.paperclipRunId ? { paperclipRunId: params.paperclipRunId } : {}),
      },
    });

    for (const stage of params.summary.stages) {
      const span = trace.span({
        name: stage.name,
        startTime: new Date(
          Date.now() - params.summary.totalMs + stage.elapsedMs - stage.durationMs,
        ),
        metadata: {
          durationMs: stage.durationMs,
          elapsedMs: stage.elapsedMs,
        },
      });
      span.end({
        endTime: new Date(Date.now() - params.summary.totalMs + stage.elapsedMs),
      });
    }

    trace.update({
      output: {
        totalMs: params.summary.totalMs,
        stageCount: params.summary.stages.length,
        ...(startupEntry ? { correlatedStartupTraceId: startupEntry.traceId } : {}),
      },
    });
  } catch {
    // Never let tracing break the gateway
  }
}
