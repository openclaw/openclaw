import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { appendRegularFileSync } from "@openclaw/fs-safe/advanced";
import { hasObservedModelUsage } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DiagnosticEventInput } from "./diagnostic-events.js";
import { isDiagnosticFlagEnabled } from "./diagnostic-flags.js";
import type { DiagnosticModelCallUsage } from "./diagnostic-model-call-types.js";
import { getActiveDiagnosticTraceContext } from "./diagnostic-trace-context.js";
import { isTruthyEnvValue } from "./env.js";
import { runWithMainThreadTask } from "./main-thread-stall.js";

const OPENCLAW_DIAGNOSTICS_TIMELINE_SCHEMA_VERSION = "openclaw.diagnostics.v1";
const MAX_PENDING_TIMELINE_BYTES = 64 * 1024;

type DiagnosticsTimelineEventType =
  | "span.start"
  | "span.end"
  | "span.error"
  | "mark"
  | "eventLoop.sample"
  | "provider.request"
  | "childProcess.exit";

type DiagnosticsTimelineAttributes = Record<string, string | number | boolean | null>;

/** Usage is a terminal observation, not proof of all requests hidden inside a logical call. */
export function modelUsageTimelineAttributes(
  usage: DiagnosticModelCallUsage | undefined,
): DiagnosticsTimelineAttributes {
  const attributes: DiagnosticsTimelineAttributes = {
    usageState:
      usage?.usageReport?.state ?? (hasObservedModelUsage(usage) ? "available" : "unreported"),
  };
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cacheWrite1h",
    "cacheWrite5m",
    "reasoningTokens",
    "promptTokens",
    "total",
  ] as const) {
    const value = usage?.[key];
    if (value !== undefined) {
      attributes[key] = value;
    }
  }
  return attributes;
}

export function recordDiagnosticModelUsageTimeline(event: DiagnosticEventInput): void {
  if (event.type !== "model.usage" || !isDiagnosticsTimelineEnabled()) {
    return;
  }
  // The process-lifetime sink survives plugin disposal and async diagnostic queue loss.
  // These aggregate observations reconcile logical calls; they are never additive to them.
  const trace = event.trace ?? getActiveDiagnosticTraceContext();
  emitDiagnosticsTimelineEvent({
    type: "mark",
    name: "model.usage",
    provider: event.provider,
    attributes: {
      ...modelUsageTimelineAttributes({ ...event.usage, usageReport: event.usageReport }),
      ...(event.model ? { model: event.model } : {}),
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(trace ? { traceId: trace.traceId } : {}),
      ...(event.purpose ? { purpose: event.purpose } : {}),
      ...(event.runtimeKind ? { runtimeKind: event.runtimeKind } : {}),
      ...(event.completionId ? { completionId: event.completionId } : {}),
      ...(event.attemptId ? { attemptId: event.attemptId } : {}),
      ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
    },
  });
}

type DiagnosticsTimelineEvent = {
  type: DiagnosticsTimelineEventType;
  name: string;
  timestamp?: string;
  runId?: string;
  envName?: string;
  pid?: number;
  phase?: string;
  spanId?: string;
  parentSpanId?: string;
  durationMs?: number;
  attributes?: DiagnosticsTimelineAttributes;
  errorName?: string;
  errorMessage?: string;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  maxMs?: number;
  activeSpanName?: string;
  provider?: string;
  operation?: string;
  ok?: boolean;
  status?: number;
  command?: string;
  exitCode?: number | null;
  signal?: string | null;
};

type DiagnosticsTimelineSpanOptions = DiagnosticsTimelineOptions &
  Pick<DiagnosticsTimelineEvent, "phase" | "parentSpanId" | "attributes"> & {
    omitErrorMessage?: boolean;
  };

export type DiagnosticsTimelineOptions = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

/** Active timeline span carried through async-local scope for nested diagnostics. */
type ActiveDiagnosticsTimelineSpan = Pick<
  DiagnosticsTimelineEvent,
  "name" | "phase" | "parentSpanId" | "attributes"
> & { spanId: string };

type StartedDiagnosticsTimelineSpan = ActiveDiagnosticsTimelineSpan & {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  startedAt: number;
  omitErrorMessage?: boolean;
};

const activeDiagnosticsTimelineSpan = new AsyncLocalStorage<ActiveDiagnosticsTimelineSpan>();
type SpanObserver = (
  name: string,
  attributes: DiagnosticsTimelineAttributes | undefined,
  durationMs?: number,
) => (() => void) | undefined;
const spanObserver = new AsyncLocalStorage<SpanObserver>();

/** Observe existing spans within one request, independently of timeline file logging. */
export function withDiagnosticsTimelineObserver<T>(observer: SpanObserver, run: () => T): T {
  return spanObserver.run(observer, run);
}

/** Forward an owner's measured duration without timing the same operation again. */
export function recordDiagnosticsTimelineDuration(name: string, durationMs: number) {
  try {
    spanObserver.getStore()?.(name, undefined, durationMs)?.();
  } catch {
    // Diagnostic observers cannot change the measured operation.
  }
}

function observeSpan(name: string, options: DiagnosticsTimelineSpanOptions) {
  let finish: (() => void) | undefined;
  try {
    finish = spanObserver.getStore()?.(name, options.attributes);
  } catch {
    // Best-effort observers cannot change the operation they measure.
  }
  if (!finish) {
    return undefined;
  }
  return {
    [Symbol.dispose]() {
      try {
        finish?.();
      } catch {
        // Preserve the original result or failure.
      }
    },
  };
}

/** Consecutive owner phases cover waits and synchronous work without gaps or extra async hops. */
export function observeDiagnosticsTimelinePhases(initialPhase: string) {
  let current = observeSpan(initialPhase, {});
  return {
    mark(phase: string) {
      current?.[Symbol.dispose]();
      current = observeSpan(phase, {});
    },
    [Symbol.dispose]() {
      current?.[Symbol.dispose]();
      current = undefined;
    },
  };
}
const timelineWriter = resolveGlobalSingleton(
  Symbol.for("openclaw.diagnosticsTimelineWriter"),
  () => {
    type Capture = { path: string; id: string; sequence: number; failedWrites: number };
    let capture: Capture | undefined;
    let pending: { capture: Capture; content: string; bytes: number } | undefined;
    let scheduledFlush: NodeJS.Immediate | undefined;
    let exiting = false;
    let warnedAboutWrite = false;
    const createdDirs = new Set<string>();

    function append(owner: Capture, content: string): void {
      try {
        const dir = dirname(owner.path);
        if (!createdDirs.has(dir)) {
          mkdirSync(dir, { recursive: true });
          createdDirs.add(dir);
        }
        appendRegularFileSync({ filePath: owner.path, content });
      } catch (error) {
        owner.failedWrites++;
        if (!warnedAboutWrite) {
          warnedAboutWrite = true;
          // Diagnostics stay best-effort; do not replay a possibly partially written batch.
          console.warn(`[diagnostics] failed to write timeline event: ${String(error)}`);
        }
      }
    }

    function flush(): void {
      if (scheduledFlush) {
        clearImmediate(scheduledFlush);
        scheduledFlush = undefined;
      }
      const batch = pending;
      pending = undefined;
      if (batch) {
        append(batch.capture, batch.content);
      }
    }

    // Install before the first event, including events first emitted by later exit listeners.
    process.once("exit", () => {
      exiting = true;
      flush();
    });

    return {
      flush,
      write(path: string, event: DiagnosticsTimelineEvent, env: NodeJS.ProcessEnv): void {
        if (capture?.path !== path) {
          flush();
          capture = { path, id: randomUUID(), sequence: 0, failedWrites: 0 };
        }
        const content = serializeTimelineEvent(
          {
            ...event,
            attributes: {
              ...event.attributes,
              captureId: capture.id,
              sequence: ++capture.sequence,
              failedWrites: capture.failedWrites,
            },
          },
          env,
        );
        const bytes = Buffer.byteLength(content, "utf8");
        if (pending && pending.bytes + bytes > MAX_PENDING_TIMELINE_BYTES) {
          flush();
        }
        // Capacity applies to retained work; preserve an oversized event without queuing or dropping it.
        if (exiting || bytes > MAX_PENDING_TIMELINE_BYTES) {
          append(capture, content);
          return;
        }
        if (pending) {
          pending.content += content;
          pending.bytes += bytes;
        } else {
          pending = { capture, content, bytes };
        }
        scheduledFlush ??= setImmediate(flush).unref();
      },
    };
  },
);

/** Makes all previously emitted timeline events visible before reading or closing their files. */
export function flushDiagnosticsTimeline(): void {
  timelineWriter.flush();
}

/** Returns true when diagnostics flags and a JSONL output path both allow timeline writes. */
export function isDiagnosticsTimelineEnabled(options: DiagnosticsTimelineOptions = {}): boolean {
  const { config, env = process.env } = options;
  const path = env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH;
  if (typeof path !== "string" || path.trim().length === 0) {
    return false;
  }
  return (
    isDiagnosticFlagEnabled("timeline", config, env) ||
    isDiagnosticFlagEnabled("diagnostics.timeline", config, env) ||
    isTruthyEnvValue(env.OPENCLAW_DIAGNOSTICS)
  );
}

function normalizeNumber(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function normalizeAttributes(
  attributes: DiagnosticsTimelineAttributes | undefined,
): DiagnosticsTimelineAttributes | undefined {
  if (!attributes) {
    return undefined;
  }
  const normalized: DiagnosticsTimelineAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        // Scalar metadata includes monetary observations, not only millisecond timings.
        normalized[key] = value;
      }
      continue;
    }
    if (typeof value === "string" || typeof value === "boolean" || value === null) {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function serializeTimelineEvent(event: DiagnosticsTimelineEvent, env: NodeJS.ProcessEnv): string {
  const attributes = normalizeAttributes(event.attributes);
  const normalized = {
    schemaVersion: OPENCLAW_DIAGNOSTICS_TIMELINE_SCHEMA_VERSION,
    type: event.type,
    timestamp: event.timestamp ?? new Date().toISOString(),
    name: event.name,
    ...(env.OPENCLAW_DIAGNOSTICS_RUN_ID ? { runId: env.OPENCLAW_DIAGNOSTICS_RUN_ID } : {}),
    ...(env.OPENCLAW_DIAGNOSTICS_ENV ? { envName: env.OPENCLAW_DIAGNOSTICS_ENV } : {}),
    pid: process.pid,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.envName ? { envName: event.envName } : {}),
    ...(typeof event.pid === "number" ? { pid: event.pid } : {}),
    phase: event.phase || undefined,
    spanId: event.spanId || undefined,
    parentSpanId: event.parentSpanId || undefined,
    durationMs: normalizeNumber(event.durationMs),
    errorName: event.errorName || undefined,
    errorMessage: event.errorMessage || undefined,
    p50Ms: normalizeNumber(event.p50Ms),
    p95Ms: normalizeNumber(event.p95Ms),
    p99Ms: normalizeNumber(event.p99Ms),
    maxMs: normalizeNumber(event.maxMs),
    activeSpanName: event.activeSpanName || undefined,
    provider: event.provider || undefined,
    operation: event.operation || undefined,
    ok: typeof event.ok === "boolean" ? event.ok : undefined,
    status: normalizeNumber(event.status),
    command: event.command || undefined,
    exitCode: event.exitCode,
    signal: event.signal,
    attributes,
  };
  return `${JSON.stringify(normalized)}\n`;
}

/** Queues one normalized event; bounded batches append on the next event-loop turn. */
export function emitDiagnosticsTimelineEvent(
  event: DiagnosticsTimelineEvent,
  options: DiagnosticsTimelineOptions = {},
): void {
  const env = options.env ?? process.env;
  if (!isDiagnosticsTimelineEnabled(options)) {
    return;
  }
  const path = env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH?.trim();
  if (!path) {
    return;
  }
  timelineWriter.write(path, event, env);
}

/** Starts the accounting window before the caller admits any model producers. */
export function startDiagnosticsTimeline(exclusiveProcess: boolean): void {
  emitDiagnosticsTimelineEvent({
    type: "mark",
    name: "timeline.capture.started",
    attributes: { exclusiveProcess },
  });
}

/** The caller owns producer settlement; flushing alone cannot certify a complete capture. */
export function finishDiagnosticsTimeline(
  complete: boolean,
  options: DiagnosticsTimelineOptions = {},
): void {
  // Flush first so a failed earlier batch remains visible in the terminal receipt.
  flushDiagnosticsTimeline();
  emitDiagnosticsTimelineEvent(
    { type: "mark", name: "timeline.capture.completed", attributes: { complete } },
    options,
  );
  flushDiagnosticsTimeline();
}

/** Replays a completed span after its activation config becomes available. */
export function emitCompletedDiagnosticsTimelineSpan(
  name: string,
  durationMs: number,
  options: DiagnosticsTimelineSpanOptions = {},
): void {
  if (!isDiagnosticsTimelineEnabled(options)) {
    return;
  }
  const span = {
    name,
    phase: options.phase,
    spanId: randomUUID(),
    parentSpanId: options.parentSpanId,
    attributes: options.attributes,
  };
  emitDiagnosticsTimelineEvent({ type: "span.start", ...span }, options);
  emitDiagnosticsTimelineEvent({ type: "span.end", ...span, durationMs }, options);
}

/** Returns the currently active span so callers can preserve parentage across memoized work. */
export function getActiveDiagnosticsTimelineSpan(): ActiveDiagnosticsTimelineSpan | undefined {
  return activeDiagnosticsTimelineSpan.getStore();
}

function startDiagnosticsTimelineSpan(
  name: string,
  options: DiagnosticsTimelineSpanOptions,
): StartedDiagnosticsTimelineSpan | undefined {
  const env = options.env ?? process.env;
  if (!isDiagnosticsTimelineEnabled({ config: options.config, env })) {
    return undefined;
  }
  const activeSpan = getActiveDiagnosticsTimelineSpan();
  const phase = options.phase ?? activeSpan?.phase;
  const parentSpanId = options.parentSpanId ?? activeSpan?.spanId;
  const span: StartedDiagnosticsTimelineSpan = {
    name,
    env,
    ...(options.config ? { config: options.config } : {}),
    spanId: randomUUID(),
    startedAt: performance.now(),
    ...(phase ? { phase } : {}),
    ...(parentSpanId ? { parentSpanId } : {}),
    ...(options.attributes ? { attributes: options.attributes } : {}),
    ...(options.omitErrorMessage ? { omitErrorMessage: true } : {}),
  };
  emitDiagnosticsTimelineEvent({ type: "span.start", ...span }, span);
  return span;
}

function runInDiagnosticsTimelineSpan<T>(span: StartedDiagnosticsTimelineSpan, run: () => T): T {
  return activeDiagnosticsTimelineSpan.run(
    {
      name: span.name,
      ...(span.phase ? { phase: span.phase } : {}),
      spanId: span.spanId,
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      ...(span.attributes ? { attributes: span.attributes } : {}),
    },
    run,
  );
}

function emitFinishedDiagnosticsTimelineSpan(
  span: StartedDiagnosticsTimelineSpan,
  failure?: { error: unknown },
): void {
  emitDiagnosticsTimelineEvent(
    {
      type: failure ? "span.error" : "span.end",
      ...span,
      durationMs: performance.now() - span.startedAt,
      ...(failure
        ? {
            errorName: failure.error instanceof Error ? failure.error.name : typeof failure.error,
            ...(span.omitErrorMessage
              ? {}
              : {
                  errorMessage:
                    failure.error instanceof Error ? failure.error.message : String(failure.error),
                }),
          }
        : {}),
    },
    span,
  );
}

/** Measures async work as a start/end timeline span, emitting an error span before rethrowing. */
export async function measureDiagnosticsTimelineSpan<T>(
  name: string,
  run: () => Promise<T> | T,
  options: DiagnosticsTimelineSpanOptions = {},
): Promise<T> {
  using _ = observeSpan(name, options);
  const span = startDiagnosticsTimelineSpan(name, options);
  if (!span) {
    return await runWithMainThreadTask(name, run);
  }
  try {
    const result = await runInDiagnosticsTimelineSpan(span, () => runWithMainThreadTask(name, run));
    emitFinishedDiagnosticsTimelineSpan(span);
    return result;
  } catch (error) {
    emitFinishedDiagnosticsTimelineSpan(span, { error });
    throw error;
  }
}

/** Measures sync work as a start/end timeline span, emitting an error span before rethrowing. */
export function measureDiagnosticsTimelineSpanSync<T>(
  name: string,
  run: () => T,
  options: DiagnosticsTimelineSpanOptions = {},
): T {
  using _ = observeSpan(name, options);
  const span = startDiagnosticsTimelineSpan(name, options);
  if (!span) {
    return runWithMainThreadTask(name, run);
  }
  try {
    const result = runInDiagnosticsTimelineSpan(span, () => runWithMainThreadTask(name, run));
    emitFinishedDiagnosticsTimelineSpan(span);
    return result;
  } catch (error) {
    emitFinishedDiagnosticsTimelineSpan(span, { error });
    throw error;
  }
}
