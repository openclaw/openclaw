import { registerSessionMaintenancePreserveKeysProvider } from "../../config/sessions/store-maintenance-preserve.js";
import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../../sessions/session-row-changes.js";
import type {
  WorkerSessionPlacementIdentity,
  WorkerSessionPlacementRecord,
} from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { isFailedWorkerPlacementEnvironmentGone } from "./placement-target.js";
import type { WorkerEnvironmentService } from "./service.js";

export type PlacementSessionEvidence = "current" | "absent" | "unknown";
export type PlacementSessionEvidenceResolver = (
  placement: WorkerSessionPlacementIdentity,
) => Promise<PlacementSessionEvidence>;

type PlacementSessionRetirementDeps = {
  placements: Pick<
    WorkerSessionPlacementStore,
    "getAsync" | "getManyAsync" | "listSessionIdentitiesAsync" | "retireSessionPlacementAsync"
  >;
  environments: Pick<WorkerEnvironmentService, "get">;
  forceDestroyEnvironment: (
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ) => Promise<unknown>;
  createSessionEvidenceResolver: (
    placements: readonly WorkerSessionPlacementIdentity[],
    signal?: AbortSignal,
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
  const installMaintenancePreservation = (
    placements: Pick<WorkerSessionPlacementStore, "prepareMaintenancePlacements">,
  ) => {
    const unsubscribeFacts = sessionChanges.subscribeFacts((change) => {
      if ("all" in change) {
        if (
          change.scope === "config" ||
          change.scope === "worker-environments" ||
          sessionChangeScopeAffectsStoredRows(change)
        ) {
          invalidateAll();
        }
      } else if (
        change.factsInvalidated === true &&
        change.scope !== "transcript" &&
        sessionChangeScopeAffectsStoredRows(change)
      ) {
        // Unknown storage outcomes have no committed identity to enqueue.
        invalidateAll();
      }
    });
    const unregisterPreservation = registerSessionMaintenancePreserveKeysProvider(async () => {
      const prepared = await placements.prepareMaintenancePlacements();
      return {
        // Session evidence survives until its remote owner is reclaimed or proven gone.
        *capture() {
          for (const placement of prepared.placements) {
            if (
              placement.state !== "failed" ||
              !isFailedWorkerPlacementEnvironmentGone({
                environmentService: deps.environments,
                placement,
              })
            ) {
              yield placement.sessionKey;
            }
          }
        },
        dispose: prepared.release,
      };
    });
    return () => {
      unsubscribeFacts();
      unregisterPreservation();
    };
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
    placement: WorkerSessionPlacementIdentity,
    resolveSessionEvidence: PlacementSessionEvidenceResolver,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const evidence = await resolveSessionEvidence(placement);
    signal?.throwIfAborted();
    if (evidence !== "absent") {
      return evidence === "current";
    }

    let current = await deps.placements.getAsync(placement.sessionId);
    signal?.throwIfAborted();
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

    signal?.throwIfAborted();
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

  const reconcile = async (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) {
      return;
    }
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
        ? await deps.placements.listSessionIdentitiesAsync()
        : [...(await deps.placements.getManyAsync(sessionIds)).values()];
      if (placements.length === 0) {
        return;
      }
      await deps.reportChanges(async () => {
        signal?.throwIfAborted();
        const resolveSessionEvidence = await deps.createSessionEvidenceResolver(placements, signal);
        for (const placement of placements) {
          signal?.throwIfAborted();
          try {
            if (!(await reconcilePlacement(placement, resolveSessionEvidence, signal))) {
              markPending(placement.sessionId);
            }
          } catch (error) {
            if (signal?.aborted && error === signal.reason) {
              throw error;
            }
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
      if (signal?.aborted && error === signal.reason) {
        return;
      }
      throw error;
    }
  };

  return { reconcile, markPending, installMaintenancePreservation };
}
