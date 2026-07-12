import type { WorkerEnvironmentService } from "./service.js";

export type WorkerInferenceControl = Pick<
  WorkerEnvironmentService,
  "cancelInferenceForSession" | "hasInferenceForSession" | "resolveInferenceSessionForRunId"
>;

export function asWorkerInferenceControl(service: unknown): WorkerInferenceControl | undefined {
  return service as WorkerInferenceControl | undefined;
}
