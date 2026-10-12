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
) {
  const registered = {
    get: () => undefined,
    ...service,
  };
  registerWorkerInferenceSessionControl(registered, {
    hasSession: () => false,
    reserveSessionDrain: (sessionId) => {
      const completed = createDeferred();
      let drain: WorkerInferenceSessionDrain | undefined;
      let started = false;
      const release = () => drain?.release();
      return {
        assertReserved: () => {},
        release,
        accept: () => ({
          drained: completed.promise,
          hasWork: () => drain?.hasWork() ?? false,
          release,
          start: () => {
            if (started) {
              return;
            }
            started = true;
            try {
              drain = startDrain(sessionId);
              void drain.drained.then(completed.resolve, completed.reject);
            } catch (error) {
              completed.reject(error);
            }
          },
        }),
      };
    },
    captureSessionCancellation: () => ({ runIds: [], cancel: async () => [] }),
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
    destroyUnattached: unexpected,
    observeDesktop: unexpected,
    launchDesktopApp: unexpected,
    startTunnel: unexpected,
    stopTunnel: unexpected,
  };
}
