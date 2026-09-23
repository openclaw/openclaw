import type { WorkerEnvironmentService } from "./service.js";

type WorkerInferenceControl = Pick<
  WorkerEnvironmentService,
  "cancelInferenceForSession" | "hasInferenceForSession"
>;

export function asWorkerInferenceControl(service: unknown): WorkerInferenceControl | undefined {
  return service as WorkerInferenceControl | undefined;
}
