import type { OpenClawConfig } from "../config/config.js";
import { isDiagnosticFlagEnabled } from "./diagnostic-flags.js";

const MB = 1024 * 1024;

export type PerfTraceLogger = (message: string) => void;

export type PerfTraceMeta = Record<string, unknown>;

export type PerfTrace = {
  enabled: boolean;
  mark: (phase: string, meta?: PerfTraceMeta) => void;
  end: (meta?: PerfTraceMeta) => void;
  fail: (phase: string, error: unknown, meta?: PerfTraceMeta) => void;
};

type PerfTraceSnapshot = {
  atNs: bigint;
  cpu: NodeJS.CpuUsage;
  memory: NodeJS.MemoryUsage;
};

function roundMetric(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function toMb(value: number): number {
  return roundMetric(value / MB);
}

function toMsFromNs(value: bigint): number {
  return roundMetric(Number(value) / 1_000_000, 1);
}

function toMsFromMicros(value: number): number {
  return roundMetric(value / 1_000, 1);
}

function capturePerfTraceSnapshot(): PerfTraceSnapshot {
  return {
    atNs: process.hrtime.bigint(),
    cpu: process.cpuUsage(),
    memory: process.memoryUsage(),
  };
}

function diffCpuUsage(next: NodeJS.CpuUsage, prev: NodeJS.CpuUsage) {
  const userMicros = Math.max(0, next.user - prev.user);
  const systemMicros = Math.max(0, next.system - prev.system);
  return {
    userMs: toMsFromMicros(userMicros),
    systemMs: toMsFromMicros(systemMicros),
    totalMs: toMsFromMicros(userMicros + systemMicros),
  };
}

function diffMemoryUsage(next: NodeJS.MemoryUsage, prev: NodeJS.MemoryUsage) {
  return {
    rssDeltaMb: toMb(next.rss - prev.rss),
    heapUsedDeltaMb: toMb(next.heapUsed - prev.heapUsed),
    heapTotalDeltaMb: toMb(next.heapTotal - prev.heapTotal),
    externalDeltaMb: toMb(next.external - prev.external),
    arrayBuffersDeltaMb: toMb(next.arrayBuffers - prev.arrayBuffers),
  };
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function normalizePerfTraceFlags(flags: string | readonly string[]): string[] {
  const values = Array.isArray(flags) ? flags : [flags];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

export function isPerfTraceEnabled(params: {
  flags: string | readonly string[];
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return normalizePerfTraceFlags(params.flags).some((flag) =>
    isDiagnosticFlagEnabled(flag, params.cfg, params.env),
  );
}

function buildPerfTraceLogLine(params: {
  label: string;
  phase: string;
  sinceStart: PerfTraceSnapshot;
  sinceLast: PerfTraceSnapshot;
  current: PerfTraceSnapshot;
  meta?: PerfTraceMeta;
  status?: "mark" | "end" | "error";
}) {
  const totalCpu = diffCpuUsage(params.current.cpu, params.sinceStart.cpu);
  const stepCpu = diffCpuUsage(params.current.cpu, params.sinceLast.cpu);
  const totalMemory = diffMemoryUsage(params.current.memory, params.sinceStart.memory);
  const stepMemory = diffMemoryUsage(params.current.memory, params.sinceLast.memory);
  return JSON.stringify({
    trace: params.label,
    phase: params.phase,
    status: params.status ?? "mark",
    pid: process.pid,
    wallMs: toMsFromNs(params.current.atNs - params.sinceStart.atNs),
    stepWallMs: toMsFromNs(params.current.atNs - params.sinceLast.atNs),
    cpuMs: totalCpu.totalMs,
    cpuUserMs: totalCpu.userMs,
    cpuSystemMs: totalCpu.systemMs,
    stepCpuMs: stepCpu.totalMs,
    stepCpuUserMs: stepCpu.userMs,
    stepCpuSystemMs: stepCpu.systemMs,
    rssMb: toMb(params.current.memory.rss),
    heapUsedMb: toMb(params.current.memory.heapUsed),
    heapTotalMb: toMb(params.current.memory.heapTotal),
    externalMb: toMb(params.current.memory.external),
    arrayBuffersMb: toMb(params.current.memory.arrayBuffers),
    rssDeltaMb: totalMemory.rssDeltaMb,
    heapUsedDeltaMb: totalMemory.heapUsedDeltaMb,
    heapTotalDeltaMb: totalMemory.heapTotalDeltaMb,
    externalDeltaMb: totalMemory.externalDeltaMb,
    arrayBuffersDeltaMb: totalMemory.arrayBuffersDeltaMb,
    stepRssDeltaMb: stepMemory.rssDeltaMb,
    stepHeapUsedDeltaMb: stepMemory.heapUsedDeltaMb,
    stepHeapTotalDeltaMb: stepMemory.heapTotalDeltaMb,
    stepExternalDeltaMb: stepMemory.externalDeltaMb,
    stepArrayBuffersDeltaMb: stepMemory.arrayBuffersDeltaMb,
    ...(params.meta && Object.keys(params.meta).length > 0 ? { meta: params.meta } : {}),
  });
}

export function createPerfTrace(params: {
  label: string;
  flags: string | readonly string[];
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log?: PerfTraceLogger;
  meta?: PerfTraceMeta;
}): PerfTrace {
  if (!isPerfTraceEnabled(params)) {
    return {
      enabled: false,
      mark: () => {},
      end: () => {},
      fail: () => {},
    };
  }

  const log = params.log ?? ((message: string) => console.log(message));
  const start = capturePerfTraceSnapshot();
  let last = start;

  const emit = (phase: string, meta?: PerfTraceMeta, status?: "mark" | "end" | "error") => {
    const current = capturePerfTraceSnapshot();
    log(
      `[perf:${params.label}] ${buildPerfTraceLogLine({
        label: params.label,
        phase,
        sinceStart: start,
        sinceLast: last,
        current,
        status,
        meta: {
          ...(params.meta ?? {}),
          ...(meta ?? {}),
        },
      })}`,
    );
    last = current;
  };

  return {
    enabled: true,
    mark: (phase, meta) => {
      emit(phase, meta, "mark");
    },
    end: (meta) => {
      emit("end", meta, "end");
    },
    fail: (phase, error, meta) => {
      emit(
        phase,
        {
          ...(meta ?? {}),
          error: stringifyError(error),
        },
        "error",
      );
    },
  };
}
