import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import {
  isFailedWorkerPlacementEnvironmentGone,
  matchesWorkerPlacementTarget,
} from "./placement-target.js";
import type { WorkerEnvironmentService } from "./service.js";

export type PlacementSessionEvidence = "current" | "absent" | "unknown";
export type PlacementSessionEvidenceResolver = (
  placement: WorkerSessionPlacementRecord,
) => Promise<PlacementSessionEvidence>;

type PlacementSessionRetirementDeps = {
  placements: Pick<
    WorkerSessionPlacementStore,
    "getAsync" | "listAsync" | "retireSessionPlacementAsync"
  >;
  environments: Pick<WorkerEnvironmentService, "get">;
  forceDestroyEnvironment: (
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ) => Promise<unknown>;
  createSessionEvidenceResolver: (
    placements: readonly WorkerSessionPlacementRecord[],
  ) => Promise<PlacementSessionEvidenceResolver>;
  reportChanges: (
    operation: () => Promise<void>,
    before: readonly WorkerSessionPlacementRecord[],
  ) => Promise<void>;
  warn: (message: string) => void;
};

export function createPlacementSessionRetirement(deps: PlacementSessionRetirementDeps) {
  const retireCurrent = async (placement: WorkerSessionPlacementRecord): Promise<boolean> => {
    if (placement.turnClaim) {
      return false;
    }
    if (
      placement.environmentId !== null &&
      placement.state !== "reclaimed" &&
      (placement.state !== "failed" ||
        !isFailedWorkerPlacementEnvironmentGone({
          environmentService: deps.environments,
          placement,
        }))
    ) {
      return false;
    }
    // Dispatch binds environment intent before entering provisioning.
    if (placement.state === "provisioning") {
      return false;
    }
    await deps.placements.retireSessionPlacementAsync({
      sessionId: placement.sessionId,
      expectedState: placement.state,
      expectedGeneration: placement.generation,
    });
    if (placement.state === "requested") {
      deps.warn(
        `Retired ownerless worker placement ${placement.sessionId} because its authoritative session is absent (${placement.state}@${placement.generation})`,
      );
    }
    return true;
  };

  const reconcilePlacement = async (
    placement: WorkerSessionPlacementRecord,
    resolveSessionEvidence: PlacementSessionEvidenceResolver,
  ): Promise<void> => {
    const evidence = await resolveSessionEvidence(placement);
    if (evidence !== "absent") {
      return;
    }

    const current = await deps.placements.getAsync(placement.sessionId);
    if (
      !current ||
      current.agentId !== placement.agentId ||
      current.sessionKey !== placement.sessionKey ||
      !matchesWorkerPlacementTarget(current, placement)
    ) {
      return;
    }
    try {
      if (await retireCurrent(current)) {
        return;
      }
    } catch {
      return;
    }

    const environmentId = current.environmentId;
    if (!environmentId) {
      return;
    }
    try {
      await deps.forceDestroyEnvironment(environmentId, (error) => {
        deps.warn(
          `Worker placement orphan cleanup deferred for ${current.sessionId}: ${String(error)}`,
        );
      });
    } catch (error) {
      deps.warn(
        `Worker placement orphan teardown failed for ${current.sessionId}: ${String(error)}`,
      );
    }

    // Teardown can change the placement or yield to a replacement. Its result
    // does not carry the old absence evidence: the next sweep observes the
    // resulting target and establishes fresh evidence before retiring it.
  };

  const reconcile = async (): Promise<void> => {
    const placements = await deps.placements.listAsync();
    if (placements.length === 0) {
      return;
    }
    // The retirement scan already supplies the complete before-snapshot for reporting.
    await deps.reportChanges(async () => {
      const resolveSessionEvidence = await deps.createSessionEvidenceResolver(placements);
      for (const placement of placements) {
        try {
          await reconcilePlacement(placement, resolveSessionEvidence);
        } catch (error) {
          deps.warn(
            `Worker placement session evidence check failed for ${placement.sessionId}: ${String(error)}`,
          );
        }
      }
    }, placements);
  };

  return { reconcile };
}
