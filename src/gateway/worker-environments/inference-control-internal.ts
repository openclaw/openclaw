export type WorkerInferenceSessionDrain = {
  drained: Promise<void>;
  hasWork(): boolean;
  release(): void;
};

export class WorkerInferenceSessionDrainBusyError extends Error {
  constructor(sessionId: string) {
    super(`Worker inference drain already owns session ${sessionId}`);
  }
}

export type WorkerInferenceCancellation = {
  readonly runIds: readonly string[];
  cancel(control?: { assertCurrent?: () => void; onCancelled?: (runId: string) => void }): string[];
};

type WorkerInferenceSessionControl = {
  beginDrain: (sessionId: string) => WorkerInferenceSessionDrain;
  captureCancel: (sessionId: string, runId?: string) => WorkerInferenceCancellation;
};

// Session lifecycle needs a stronger control without widening the inferred public service shape.
// The weak registration follows the concrete service instance's lifetime.
const sessionControlByService = new WeakMap<object, WorkerInferenceSessionControl>();

export function registerWorkerInferenceSessionControl(
  service: object,
  control: WorkerInferenceSessionControl,
): void {
  sessionControlByService.set(service, control);
}

export function beginWorkerInferenceSessionDrain(
  service: unknown,
  sessionId: string,
): WorkerInferenceSessionDrain | undefined {
  if (typeof service !== "object" || service === null) {
    return undefined;
  }
  return sessionControlByService.get(service)?.beginDrain(sessionId);
}

export function captureWorkerInferenceCancellation(
  service: unknown,
  sessionId: string,
  runId?: string,
): WorkerInferenceCancellation | undefined {
  if (typeof service !== "object" || service === null) {
    return undefined;
  }
  return sessionControlByService.get(service)?.captureCancel(sessionId, runId);
}
