import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { areDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createStageTimingTracker } from "../../shared/stage-timing.js";
import type {
  SessionListDiagnostics,
  SessionListPhase,
} from "../session-list-diagnostics.types.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const sessionListDiagnostics = channel("openclaw.session.list");

function startSessionListDiagnostics(
  respond: RespondFn,
  operation: "sessions.list" | "sessions.subscribe",
) {
  const logEnabled = areDiagnosticsEnabledForProcess() && sessionLog.isEnabled("warn");
  if (!logEnabled && !sessionListDiagnostics.hasSubscribers) {
    return undefined;
  }
  let checkpoint = performance.now();
  const startedAt = checkpoint;
  const timing = createStageTimingTracker(() => checkpoint);
  const trace = getActiveDiagnosticTraceContext();
  let phase: SessionListPhase = "setup";
  const projection: SessionListDiagnostics["projection"] = {
    prepareSyncMs: 0,
    rowSyncMs: 0,
    yieldWaitMs: 0,
    yieldCount: 0,
    selectedRowCount: 0,
    dirtyRowCount: 0,
    materializedRowCount: 0,
    reusedRowCount: 0,
  };
  let responseOutcome: "none" | "ok" | "error" | "threw" = "none";
  let cpuMetrics:
    | Partial<Record<Parameters<SessionListDiagnostics["finishSyncCpu"]>[0], number>>
    | undefined = {};
  const startSyncCpu = (): NodeJS.CpuUsage | undefined => {
    if (!cpuMetrics) {
      return undefined;
    }
    try {
      return process.threadCpuUsage();
    } catch {
      cpuMetrics = undefined;
      return undefined;
    }
  };
  const finishSyncCpu = (
    metric: Parameters<SessionListDiagnostics["finishSyncCpu"]>[0],
    started: NodeJS.CpuUsage | undefined,
  ) => {
    if (!started || !cpuMetrics) {
      return;
    }
    try {
      const used = process.threadCpuUsage(started);
      cpuMetrics[metric] = (cpuMetrics[metric] ?? 0) + (used.user + used.system) / 1_000;
    } catch {
      // Failed probes omit CPU totals for this request without replacing its result.
      cpuMetrics = undefined;
    }
  };
  const mark = (next: SessionListPhase) => {
    checkpoint = performance.now();
    timing.mark(phase);
    phase = next;
  };
  return {
    trace,
    mark,
    startSyncCpu,
    finishSyncCpu,
    get projection() {
      return projection;
    },
    respond: ((...args) => {
      mark("response");
      responseOutcome = args[0] ? "ok" : "error";
      const responseCpu = startSyncCpu();
      try {
        return respond(...args);
      } catch (error) {
        responseOutcome = "threw";
        throw error;
      } finally {
        finishSyncCpu("responseThreadCpuMs", responseCpu);
        mark("handlerExit");
      }
    }) satisfies RespondFn,
    finish(handlerOutcome: "returned" | "threw") {
      mark("handlerExit");
      const handlerElapsedMs = checkpoint - startedAt;
      const shouldLog =
        logEnabled && handlerElapsedMs >= 1_000 && areDiagnosticsEnabledForProcess();
      if (!shouldLog && !sessionListDiagnostics.hasSubscribers) {
        return;
      }
      try {
        // Repair repeats phases; sum them without retaining row or yield records.
        const phaseDurationsMs: Record<string, number> = {};
        for (const stage of timing.snapshot().stages) {
          phaseDurationsMs[stage.name] = (phaseDurationsMs[stage.name] ?? 0) + stage.durationMs;
        }
        const fields = {
          operation,
          pid: process.pid,
          threadId,
          isMainThread,
          handlerElapsedMs: Math.round(handlerElapsedMs),
          phaseDurationsMs,
          ...cpuMetrics,
          ...(projection
            ? Object.fromEntries(
                Object.entries(projection).map(([key, value]) => [key, Math.round(value)]),
              )
            : {}),
          handlerOutcome,
          responseOutcome,
        };
        if (sessionListDiagnostics.hasSubscribers) {
          sessionListDiagnostics.publish(fields);
        }
        if (shouldLog) {
          runWithDiagnosticTraceContext(trace, () =>
            sessionLog.warn("slow session list", {
              ...fields,
            }),
          );
        }
      } catch {
        // Diagnostic sinks cannot replace the response or original exception.
      }
    },
  };
}

export function withSessionListDiagnostics(
  handler: (
    args: GatewayRequestHandlerOptions,
    diagnostics?: SessionListDiagnostics,
  ) => Promise<void>,
): GatewayRequestHandler {
  return async (args) => {
    const diagnostics = startSessionListDiagnostics(
      args.respond,
      args.req.method === "sessions.subscribe" ? "sessions.subscribe" : "sessions.list",
    );
    let outcome: "returned" | "threw" = "returned";
    try {
      await handler(diagnostics ? { ...args, respond: diagnostics.respond } : args, diagnostics);
    } catch (error) {
      outcome = "threw";
      throw error;
    } finally {
      diagnostics?.finish(outcome);
    }
  };
}
