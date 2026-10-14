import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./placement-target.js";
import type { WorkerEnvironmentService } from "./service.js";

export type PlacementSessionEvidence = "current" | "absent" | "unknown";
export type PlacementSessionEvidenceResolver = (
  placement: WorkerSessionPlacementRecord,
) => Promise<PlacementSessionEvidence>;

type PlacementSessionRetirementDeps = {
  placements: Pick<
    WorkerSessionPlacementStore,
    "getAsync" | "getManyAsync" | "listAsync" | "retireSessionPlacementAsync"
  >;
  environments: Pick<WorkerEnvironmentService, "get">;
  forceDestroyEnvironment: (
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ) => Promise<unknown>;
  createSessionEvidenceResolver: (
    placements: readonly WorkerSessionPlacementRecord[],
  ) => Promise<PlacementSessionEvidenceResolver>;
  reportChanges: (operation: () => Promise<void>) => Promise<void>;
  warn: (message: string) => void;
};

export function createPlacementSessionRetirement(deps: PlacementSessionRetirementDeps) {
  const pending = new Set<string>();
  let fullScanPending = true;
  const markPending = (sessionId: string) => {
    pending.add(sessionId);
  };
  const invalidateAll = () => {
    fullScanPending = true;
  };
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
  ): Promise<boolean> => {
    const evidence = await resolveSessionEvidence(placement);
    if (evidence !== "absent") {
      return evidence === "current";
    }

    let current = await deps.placements.getAsync(placement.sessionId);
    if (!current) {
      return true;
    }
    try {
      if (await retireCurrent(current)) {
        return true;
      }
    } catch {
      return false;
    }

    const environmentId = current.environmentId;
    if (!environmentId) {
      return false;
    }
    try {
      await deps.forceDestroyEnvironment(environmentId, (error) => {
        deps.warn(
          `Worker placement orphan cleanup deferred for ${current?.sessionId ?? placement.sessionId}: ${String(error)}`,
        );
      });
    } catch (error) {
      deps.warn(
        `Worker placement orphan teardown failed for ${current.sessionId}: ${String(error)}`,
      );
      return false;
    }

    current = await deps.placements.getAsync(placement.sessionId);
    if (!current) {
      return true;
    }
    try {
      return await retireCurrent(current);
    } catch {
      // A concurrent placement transition owns the next reconciliation pass.
      return false;
    }
  };

  const reconcile = async (): Promise<void> => {
    const readAll = fullScanPending;
    const sessionIds = [...pending];
    // Drain before yielding so receipts arriving during this pass remain queued.
    fullScanPending = false;
    pending.clear();
    if (!readAll && sessionIds.length === 0) {
      return;
    }
    try {
      const placements = readAll
        ? await deps.placements.listAsync()
        : [...(await deps.placements.getManyAsync(sessionIds)).values()];
      if (placements.length === 0) {
        return;
      }
      await deps.reportChanges(async () => {
        const resolveSessionEvidence = await deps.createSessionEvidenceResolver(placements);
        for (const placement of placements) {
          try {
            if (!(await reconcilePlacement(placement, resolveSessionEvidence))) {
              markPending(placement.sessionId);
            }
          } catch (error) {
            markPending(placement.sessionId);
            deps.warn(
              `Worker placement session evidence check failed for ${placement.sessionId}: ${String(error)}`,
            );
          }
        }
      });
    } catch (error) {
      fullScanPending ||= readAll;
      sessionIds.forEach(markPending);
      throw error;
    }
  };

  return { reconcile, markPending, invalidateAll };
}
