import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { appendRegularFileSync } from "@openclaw/fs-safe/advanced";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isDiagnosticFlagEnabled } from "./diagnostic-flags.js";
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

type DiagnosticsTimelineOptions = {
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
