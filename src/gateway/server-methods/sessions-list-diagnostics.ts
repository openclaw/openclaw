import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { areDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createStageTimingTracker } from "../../shared/stage-timing.js";
import type { SessionListProjectionTiming } from "../session-utils-list.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

type Phase =
  | "setup"
  | "modelCatalog"
  | "cacheSelectionOrWait"
  | "storeLoad"
  | "filterSetup"
  | "rows"
  | "sharing"
  | "decoration"
  | "visibilityRepair"
  | "response"
  | "handlerExit";
type CacheRole = "unreached" | "completed-hit" | "in-flight-follower" | "projection-owner";

export type SessionListDiagnostics = NonNullable<ReturnType<typeof startSessionListDiagnostics>>;

function startSessionListDiagnostics(respond: RespondFn) {
  if (!areDiagnosticsEnabledForProcess() || !sessionLog.isEnabled("warn")) {
    return undefined;
  }
  let checkpoint = performance.now();
  const startedAt = checkpoint;
  const timing = createStageTimingTracker(() => checkpoint);
  const trace = getActiveDiagnosticTraceContext();
  let phase: Phase = "setup";
  let cacheRole: CacheRole = "unreached";
  let workTrace: DiagnosticTraceContext | undefined;
  let projection:
    | (SessionListProjectionTiming & {
        projectionPasses: number;
        rowRepairCount: number;
        fullReloadCount: number;
      })
    | undefined;
  let selectedRowCount: number | undefined;
  let responseOutcome: "none" | "ok" | "error" | "threw" = "none";
  const mark = (next: Phase) => {
    checkpoint = performance.now();
    timing.mark(phase);
    phase = next;
  };
  return {
    trace,
    mark,
    get projection() {
      return projection;
    },
    setCacheRole(role: CacheRole, producerTrace?: DiagnosticTraceContext) {
      cacheRole = role;
      workTrace = producerTrace;
      if (role === "projection-owner") {
        projection = {
          prepareSyncMs: 0,
          rowSyncMs: 0,
          yieldWaitMs: 0,
          yieldCount: 0,
          projectionPasses: 0,
          rowRepairCount: 0,
          fullReloadCount: 0,
        };
      }
    },
    respond: ((...args) => {
      mark("response");
      responseOutcome = args[0] ? "ok" : "error";
      try {
        return respond(...args);
      } catch (error) {
        responseOutcome = "threw";
        throw error;
      } finally {
        mark("handlerExit");
      }
    }) satisfies RespondFn,
    setSelectedRowCount(count: number) {
      selectedRowCount = count;
    },
    finish(handlerOutcome: "returned" | "threw") {
      mark("handlerExit");
      const handlerElapsedMs = checkpoint - startedAt;
      if (handlerElapsedMs < 1_000 || !areDiagnosticsEnabledForProcess()) {
        return;
      }
      try {
        // Repair repeats phases; sum them without retaining row or yield records.
        const phaseDurationsMs: Record<string, number> = {};
        for (const stage of timing.snapshot().stages) {
          phaseDurationsMs[stage.name] = (phaseDurationsMs[stage.name] ?? 0) + stage.durationMs;
        }
        runWithDiagnosticTraceContext(trace, () =>
          sessionLog.warn("slow session list", {
            operation: "sessions.list",
            pid: process.pid,
            threadId,
            isMainThread,
            handlerElapsedMs: Math.round(handlerElapsedMs),
            cacheRole,
            ...(workTrace ? { workTraceId: workTrace.traceId, workSpanId: workTrace.spanId } : {}),
            phaseDurationsMs,
            ...(projection
              ? Object.fromEntries(
                  Object.entries(projection).map(([key, value]) => [key, Math.round(value)]),
                )
              : {}),
            ...(selectedRowCount === undefined ? {} : { selectedRowCount }),
            handlerOutcome,
            responseOutcome,
          }),
        );
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
    const diagnostics = startSessionListDiagnostics(args.respond);
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
