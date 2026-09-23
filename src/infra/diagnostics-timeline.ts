// Records structured diagnostics timeline events and spans.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isDiagnosticFlagEnabled } from "./diagnostic-flags.js";
import { isTruthyEnvValue } from "./env.js";
import { appendRegularFileSync } from "./regular-file.js";

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

type DiagnosticsTimelineSpanOptions = {
  phase?: string;
  parentSpanId?: string;
  attributes?: DiagnosticsTimelineAttributes;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  omitErrorMessage?: boolean;
  /** Observe only worker completions submitted in this exact async span. */
  workerTasks?: boolean;
};

type DiagnosticsTimelineOptions = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

/** Active timeline span carried through async-local scope for nested diagnostics. */
type ActiveDiagnosticsTimelineSpan = {
  name: string;
  phase?: string;
  spanId: string;
  parentSpanId?: string;
  attributes?: DiagnosticsTimelineAttributes;
};

type StartedDiagnosticsTimelineSpan = ActiveDiagnosticsTimelineSpan & {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  startedAt: number;
  omitErrorMessage?: boolean;
};

const activeDiagnosticsTimelineSpan = new AsyncLocalStorage<ActiveDiagnosticsTimelineSpan>();
const timelineWriter = resolveGlobalSingleton(
  Symbol.for("openclaw.diagnosticsTimelineWriter"),
  () => {
    let pending: { path: string; content: string; bytes: number } | undefined;
    let scheduledFlush: NodeJS.Immediate | undefined;
    let exiting = false;
    let warnedAboutWrite = false;
    const createdDirs = new Set<string>();

    function append(path: string, content: string): void {
      try {
        const dir = dirname(path);
        if (!createdDirs.has(dir)) {
          mkdirSync(dir, { recursive: true });
          createdDirs.add(dir);
        }
        appendRegularFileSync({ filePath: path, content });
      } catch (error) {
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
        append(batch.path, batch.content);
      }
    }

    // Install before the first event, including events first emitted by later exit listeners.
    process.once("exit", () => {
      exiting = true;
      flush();
    });

    return {
      flush,
      write(path: string, content: string): void {
        const bytes = Buffer.byteLength(content, "utf8");
        if (
          pending &&
          (pending.path !== path || pending.bytes + bytes > MAX_PENDING_TIMELINE_BYTES)
        ) {
          flush();
        }
        // Capacity applies to retained work; preserve an oversized event without queuing or dropping it.
        if (exiting || bytes > MAX_PENDING_TIMELINE_BYTES) {
          append(path, content);
          return;
        }
        if (pending) {
          pending.content += content;
          pending.bytes += bytes;
        } else {
          pending = { path, content, bytes };
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
  return (
    (isDiagnosticFlagEnabled("timeline", config, env) ||
      isDiagnosticFlagEnabled("diagnostics.timeline", config, env) ||
      isTruthyEnvValue(env.OPENCLAW_DIAGNOSTICS)) &&
    typeof env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH === "string" &&
    env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH.trim().length > 0
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
        normalized[key] = normalizeNumber(value) ?? 0;
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
    ...(event.phase ? { phase: event.phase } : {}),
    ...(event.spanId ? { spanId: event.spanId } : {}),
    ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
    ...(typeof event.durationMs === "number"
      ? { durationMs: normalizeNumber(event.durationMs) }
      : {}),
    ...(event.errorName ? { errorName: event.errorName } : {}),
    ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
    ...(typeof event.p50Ms === "number" ? { p50Ms: normalizeNumber(event.p50Ms) } : {}),
    ...(typeof event.p95Ms === "number" ? { p95Ms: normalizeNumber(event.p95Ms) } : {}),
    ...(typeof event.p99Ms === "number" ? { p99Ms: normalizeNumber(event.p99Ms) } : {}),
    ...(typeof event.maxMs === "number" ? { maxMs: normalizeNumber(event.maxMs) } : {}),
    ...(event.activeSpanName ? { activeSpanName: event.activeSpanName } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.operation ? { operation: event.operation } : {}),
    ...(typeof event.ok === "boolean" ? { ok: event.ok } : {}),
    ...(typeof event.status === "number" ? { status: normalizeNumber(event.status) } : {}),
    ...(event.command ? { command: event.command } : {}),
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    ...(event.signal !== undefined ? { signal: event.signal } : {}),
    ...(attributes ? { attributes } : {}),
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
  timelineWriter.write(path, serializeTimelineEvent(event, env));
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
  const spanId = randomUUID();
  emitDiagnosticsTimelineEvent(
    {
      type: "span.start",
      name,
      phase: options.phase,
      spanId,
      parentSpanId: options.parentSpanId,
      attributes: options.attributes,
    },
    options,
  );
  emitDiagnosticsTimelineEvent(
    {
      type: "span.end",
      name,
      phase: options.phase,
      spanId,
      parentSpanId: options.parentSpanId,
      durationMs,
      attributes: options.attributes,
    },
    options,
  );
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
  emitDiagnosticsTimelineEvent(
    {
      type: "span.start",
      name: span.name,
      phase: span.phase,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      attributes: span.attributes,
    },
    { config: span.config, env: span.env },
  );
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

function emitFinishedDiagnosticsTimelineSpan(span: StartedDiagnosticsTimelineSpan): void {
  emitDiagnosticsTimelineEvent(
    {
      type: "span.end",
      name: span.name,
      phase: span.phase,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      durationMs: performance.now() - span.startedAt,
      attributes: span.attributes,
    },
    { config: span.config, env: span.env },
  );
}

function emitFailedDiagnosticsTimelineSpan(
  span: StartedDiagnosticsTimelineSpan,
  error: unknown,
): void {
  emitDiagnosticsTimelineEvent(
    {
      type: "span.error",
      name: span.name,
      phase: span.phase,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      durationMs: performance.now() - span.startedAt,
      attributes: span.attributes,
      errorName: error instanceof Error ? error.name : typeof error,
      ...(span.omitErrorMessage
        ? {}
        : { errorMessage: error instanceof Error ? error.message : String(error) }),
    },
    { config: span.config, env: span.env },
  );
}

function observeSpanWorkerTasks(span: StartedDiagnosticsTimelineSpan): () => void {
  const workers = channel("openclaw.worker.task");
  let recorded = 0;
  let invalid = false;
  let truncated = false;
  const emit = (attributes: DiagnosticsTimelineAttributes) =>
    emitDiagnosticsTimelineEvent(
      { type: "mark", name: "worker.task", parentSpanId: span.spanId, attributes },
      { config: span.config, env: span.env },
    );
  const recordInvalid = () => {
    if (invalid) {
      return;
    }
    invalid = true;
    emit({ status: "invalid" });
  };
  const observe = (message: unknown) => {
    try {
      // The pool restores the submitting context before publishing and settling.
      // Descendants and coalesced followers do not own this span's worker metrics.
      if (getActiveDiagnosticsTimelineSpan()?.spanId !== span.spanId) {
        return;
      }
      if (!isRecord(message)) {
        return recordInvalid();
      }
      const { outcome, queueMs, preparationMs, runMs, transferMs } = message;
      if (
        (outcome !== "ok" && outcome !== "failed") ||
        typeof queueMs !== "number" ||
        typeof preparationMs !== "number" ||
        typeof runMs !== "number" ||
        typeof transferMs !== "number" ||
        ![queueMs, preparationMs, runMs, transferMs].every(
          (value) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER,
        )
      ) {
        return recordInvalid();
      }
      if (recorded === 4) {
        if (!truncated) {
          truncated = true;
          emit({ status: "truncated" });
        }
        return;
      }
      recorded++;
      emit({
        status: "captured",
        outcome,
        queueMs,
        preparationMs,
        runMs,
        transferMs,
      });
    } catch {
      // diagnostics_channel rethrows subscriber failures as uncaught exceptions.
      try {
        recordInvalid();
      } catch {
        /* Diagnostics cannot change task settlement. */
      }
    }
  };
  try {
    workers.subscribe(observe);
  } catch {
    /* Work remains authoritative. */
  }
  return () => {
    try {
      workers.unsubscribe(observe);
    } catch {
      /* Preserve the work's result or error. */
    }
  };
}

/** Measures async work as a start/end timeline span, emitting an error span before rethrowing. */
export async function measureDiagnosticsTimelineSpan<T>(
  name: string,
  run: () => Promise<T> | T,
  options: DiagnosticsTimelineSpanOptions = {},
): Promise<T> {
  const span = startDiagnosticsTimelineSpan(name, options);
  if (!span) {
    return await run();
  }
  const stopObserving = options.workerTasks ? observeSpanWorkerTasks(span) : undefined;
  try {
    const result = await runInDiagnosticsTimelineSpan(span, () => run());
    emitFinishedDiagnosticsTimelineSpan(span);
    return result;
  } catch (error) {
    emitFailedDiagnosticsTimelineSpan(span, error);
    throw error;
  } finally {
    stopObserving?.();
  }
}

/** Measures sync work as a start/end timeline span, emitting an error span before rethrowing. */
export function measureDiagnosticsTimelineSpanSync<T>(
  name: string,
  run: () => T,
  options: DiagnosticsTimelineSpanOptions = {},
): T {
  const span = startDiagnosticsTimelineSpan(name, options);
  if (!span) {
    return run();
  }
  try {
    const result = runInDiagnosticsTimelineSpan(span, run);
    emitFinishedDiagnosticsTimelineSpan(span);
    return result;
  } catch (error) {
    emitFailedDiagnosticsTimelineSpan(span, error);
    throw error;
  }
}
