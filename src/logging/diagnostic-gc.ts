import { hasInternalDiagnosticEventInterest } from "../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { runWithDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { observeGcSamples, type GcSample } from "../infra/gc-observer.js";
import { setTrackedWorkerGcObserver } from "../infra/worker-cpu.js";

let stopObserver: (() => void) | undefined;

export function stopDiagnosticGcObserver(): void {
  stopObserver?.();
  stopObserver = undefined;
  setTrackedWorkerGcObserver(undefined);
}

export function reconcileDiagnosticGcObserver(): void {
  if (!areDiagnosticsEnabledForProcess() || !hasInternalDiagnosticEventInterest("diagnostic.gc")) {
    stopDiagnosticGcObserver();
    return;
  }
  setTrackedWorkerGcObserver(publishGcSamples);
  stopObserver ??= observeGcSamples((samples) => publishGcSamples(samples, "main"));
}

function publishGcSamples(samples: GcSample[], thread: string, workerSlot?: number): void {
  if (!areDiagnosticsEnabledForProcess() || !hasInternalDiagnosticEventInterest("diagnostic.gc")) {
    return;
  }
  runWithDiagnosticTraceContext(undefined, () => {
    for (const sample of samples) {
      emitInternalDiagnosticEvent({ type: "diagnostic.gc", ...sample, thread, workerSlot });
    }
  });
}
