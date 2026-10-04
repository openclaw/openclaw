import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";

export type WorkerPlacementCancellationTarget = Readonly<
  Pick<WorkerSessionPlacementRecord, "state" | "generation" | "environmentId" | "activeOwnerEpoch">
>;

export function matchesWorkerPlacementTarget(
  current: WorkerPlacementCancellationTarget | undefined,
  expected: WorkerPlacementCancellationTarget | undefined,
): boolean {
  return (
    current?.state === expected?.state &&
    current?.generation === expected?.generation &&
    current?.environmentId === expected?.environmentId &&
    current?.activeOwnerEpoch === expected?.activeOwnerEpoch
  );
}

export function isFailedWorkerPlacementEnvironmentGone(params: {
  environmentService:
    | {
        get(environmentId: string): Pick<WorkerEnvironmentRecord, "state" | "leaseId"> | undefined;
      }
    | undefined;
  placement: Extract<WorkerSessionPlacementRecord, { state: "failed" }>;
}): boolean {
  if (params.placement.environmentId === null) {
    return true;
  }
  // Provisioning persists deterministic allocation intent first; only the configured service
  // can prove that the corresponding durable environment row was never created or is gone.
  if (!params.environmentService) {
    return false;
  }
  try {
    const environment = params.environmentService.get(params.placement.environmentId);
    return (
      environment === undefined ||
      environment.state === "destroyed" ||
      (environment.state === "failed" && environment.leaseId === null)
    );
  } catch {
    return false;
  }
}
