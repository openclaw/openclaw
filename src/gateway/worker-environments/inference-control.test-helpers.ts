import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import {
  registerWorkerInferenceSessionControl,
  type WorkerInferenceSessionDrain,
} from "./inference-control-internal.js";
import type { WorkerEnvironmentServiceContract } from "./service-contract.js";

export function createWorkerInferenceDrainService(
  startDrain: (sessionId: string) => WorkerInferenceSessionDrain,
  service: object = {},
  hasSession: (sessionId: string, runId?: string) => boolean = () => false,
) {
  const registered = {
    get: () => undefined,
    ...service,
  };
  registerWorkerInferenceSessionControl(registered, {
    hasSession,
    reserveSessionDrain: (sessionId) => {
      const completed = createDeferred();
      let drain: WorkerInferenceSessionDrain | undefined;
      return {
        drained: completed.promise,
        hasWork: () => drain?.hasWork() ?? false,
        release: () => drain?.release(),
        start: vi.fn<() => void>().mockImplementationOnce(() => {
          try {
            drain = startDrain(sessionId);
            completed.resolve(drain.drained);
          } catch (error) {
            completed.reject(error);
          }
        }),
      };
    },
    captureSessionCancellation: () => ({
      runIds: [],
      settled: Promise.resolve(),
      executing: false,
      cancel: async () => [],
    }),
    resolveSessionTargetForRunId: () => undefined,
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
  const service = {};
  registerWorkerInferenceSessionControl(service, {
    hasSession: (candidate, runId) =>
      candidate === sessionId && (runId === undefined ? runIds.length > 0 : runIds.includes(runId)),
    resolveSessionTargetForRunId: (runId) => (runIds.includes(runId) ? target : undefined),
    reserveSessionDrain: () => {
      throw new Error("unexpected drain reservation in cancellation fixture");
    },
    captureSessionCancellation: (candidate, runId) => {
      const captured =
        candidate === sessionId ? runIds.filter((id) => runId === undefined || id === runId) : [];
      return {
        runIds: captured,
        settled: Promise.resolve(),
        executing: false,
        cancel: async (control) => {
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

/** Drain fixtures expose the full service contract and reject unrelated operations. */
export function createWorkerInferenceServiceStub(): WorkerEnvironmentServiceContract {
  const unexpected = (): never => {
    throw new Error("Unexpected worker service operation during drain acquisition");
  };
  return {
    getDedicatedNodeLeaseSignal: unexpected,
    captureSessionAttachment: unexpected,
    getSessionAttachment: unexpected,
    findSessionAttachment: unexpected,
    getSessionAttachmentStatus: unexpected,
    assertSessionAttachment: unexpected,
    touchSessionAttachment: unexpected,
    execSessionAttachment: unexpected,
    createSessionAttachment: unexpected,
    destroySessionAttachment: unexpected,
    openNodePortal: unexpected,
    list: unexpected,
    readPreparedPoolSummary: unexpected,
    readReadyWorkerTarget: unexpected,
    get: () => undefined,
    inventoryVersion: unexpected,
    readMachineShape: unexpected,
    machineShapeVersion: unexpected,
    supportsExecutionMode: unexpected,
    readProviderDisplayId: unexpected,
    listMachineOptions: unexpected,
    listOperatingSystems: unexpected,
    prepare: unexpected,
    create: unexpected,
    destroy: unexpected,
    reclaim: unexpected,
    destroyUnattached: unexpected,
    observeDesktop: unexpected,
    launchDesktopApp: unexpected,
    startTunnel: unexpected,
    stopTunnel: unexpected,
  };
}
