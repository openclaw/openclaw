import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
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
  };
  registerWorkerInferenceSessionControl(registered, {
    beginDrain,
    captureCancel: () => ({ runIds: [], cancel: () => [] }),
    resolveTarget: () => undefined,
  });
  return registered;
}

/** Fixed cancellation-owner fixture; manager identity races use the real manager. */
export function createWorkerInferenceCancellationService(
  sessionId: string,
  runIds: string[],
  cancel: (params: { sessionId: string; runId?: string }) => string[],
  target?: BoundAgentRunSessionTarget,
) {
  const service = {
    cancelInferenceForSession: cancel,
    hasInferenceForSession: (candidate: string, runId?: string) =>
      candidate === sessionId && (runId === undefined ? runIds.length > 0 : runIds.includes(runId)),
  };
  registerWorkerInferenceSessionControl(service, {
    resolveTarget: (runId) => (runIds.includes(runId) ? target : undefined),
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
