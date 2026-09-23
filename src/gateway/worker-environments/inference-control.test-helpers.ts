import { registerWorkerInferenceSessionControl } from "./inference-control-internal.js";

export function createWorkerInferenceDrainService(
  beginDrain: Parameters<typeof registerWorkerInferenceSessionControl>[1]["beginDrain"],
  service: object = {},
) {
  const registered = {
    get: () => undefined,
    ...service,
    cancelInferenceForSession: () => [],
    hasInferenceForSession: () => false,
    resolveInferenceSessionForRunId: () => undefined,
  };
  registerWorkerInferenceSessionControl(registered, {
    beginDrain,
    captureCancel: () => ({ runIds: [], cancel: () => [] }),
  });
  return registered;
}

/** Fixed cancellation-owner fixture; manager identity races use the real manager. */
export function createWorkerInferenceCancellationService(
  sessionId: string,
  runIds: string[],
  cancel: (params: { sessionId: string; runId?: string }) => string[],
) {
  const service = {
    cancelInferenceForSession: cancel,
    hasInferenceForSession: (candidate: string, runId?: string) =>
      candidate === sessionId && (runId === undefined ? runIds.length > 0 : runIds.includes(runId)),
    resolveInferenceSessionForRunId: (runId: string) =>
      runIds.includes(runId) ? sessionId : undefined,
  };
  registerWorkerInferenceSessionControl(service, {
    beginDrain: () => {
      throw new Error("unexpected drain in cancellation fixture");
    },
    captureCancel: (candidate, runId) => {
      const captured =
        candidate === sessionId ? runIds.filter((id) => runId === undefined || id === runId) : [];
      return {
        runIds: captured,
        cancel: (control) => {
          if (!captured.length) {
            return [];
          }
          control?.assertCurrent?.();
          const cancelled = cancel({ sessionId: candidate, ...(runId ? { runId } : {}) });
          cancelled.forEach((id) => control?.onCancelled?.(id));
          return cancelled;
        },
      };
    },
  });
  return service;
}
