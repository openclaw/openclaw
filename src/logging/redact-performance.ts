import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";

const redactionPerformance = channel("openclaw.redaction");

/** The capture subscriber receives counts and synchronous CPU time, never text or patterns. */
export function startRedactionMeasurement(operation: "text" | "log-record") {
  if (!redactionPerformance.hasSubscribers) {
    return undefined;
  }
  const startedAt = performance.now();
  const cpu = process.threadCpuUsage();
  return (outcome: "ok" | "error", inputChars?: number, patternCount?: number) => {
    const elapsedMs = performance.now() - startedAt;
    const used = process.threadCpuUsage(cpu);
    redactionPerformance.publish({
      operation,
      outcome,
      pid: process.pid,
      threadId,
      isMainThread,
      elapsedMs,
      threadCpuMs: (used.user + used.system) / 1_000,
      ...(inputChars === undefined ? {} : { inputChars }),
      ...(patternCount === undefined ? {} : { patternCount }),
    });
  };
}
