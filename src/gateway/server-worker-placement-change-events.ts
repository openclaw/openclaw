import { formatErrorMessage } from "../infra/errors.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

export function createGatewayWorkerPlacementChangePublisher(params: {
  placements: Pick<WorkerSessionPlacementStore, "readChangeSnapshot">;
  getSessionChangeContext?: () => Parameters<typeof emitSessionsChanged>[0] | undefined;
  warn: (message: string) => void;
}) {
  const warnPlacementChangeFailure = (error: unknown): void => {
    try {
      params.warn(`Worker placement session change reporting failed: ${formatErrorMessage(error)}`);
    } catch {
      // Reporting failures must never replace a committed placement outcome.
    }
  };
  const snapshotPlacements = async () =>
    new Map(
      (await params.placements.readChangeSnapshot()).map((placement) => [
        placement.sessionId,
        placement,
      ]),
    );
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    let context: ReturnType<NonNullable<typeof params.getSessionChangeContext>>;
    let before: Awaited<ReturnType<typeof snapshotPlacements>> | undefined;
    try {
      context = params.getSessionChangeContext?.();
      if (context) {
        before = await snapshotPlacements();
      }
    } catch (error) {
      warnPlacementChangeFailure(error);
    }
    if (!context || !before) {
      return await operation();
    }
    try {
      return await operation();
    } finally {
      try {
        const after = await snapshotPlacements();
        for (const [sessionId, previous] of before) {
          const current = after.get(sessionId);
          if (
            current &&
            current.state === previous.state &&
            current.generation === previous.generation &&
            current.updatedAtMs === previous.updatedAtMs &&
            current.sessionKey === previous.sessionKey &&
            current.agentId === previous.agentId
          ) {
            after.delete(sessionId);
            continue;
          }
          if (!current) {
            after.set(sessionId, previous);
          }
        }
        for (const placement of after.values()) {
          try {
            emitSessionsChanged(context, {
              reason: "placement",
              sessionKey: placement.sessionKey,
              agentId: placement.agentId,
            });
          } catch (error) {
            warnPlacementChangeFailure(error);
          }
        }
      } catch (error) {
        warnPlacementChangeFailure(error);
      }
    }
  };
}

export function subscribeGatewayWorkerMachineShapeChanges(params: {
  placements: Pick<WorkerSessionPlacementStore, "readChangeSnapshot">;
  environments: Pick<WorkerEnvironmentService, "subscribeMachineShapeChanged">;
  getSessionChangeContext?: () => Parameters<typeof emitSessionsChanged>[0] | undefined;
  warn: (message: string) => void;
}) {
  const profiles = new Set<string>();
  let stopped = false;
  let pending: Promise<void> | undefined;
  const unsubscribe = params.environments.subscribeMachineShapeChanged((profileId) => {
    if (stopped || !params.getSessionChangeContext?.()) {
      return;
    }
    profiles.add(profileId);
    if (pending) {
      return;
    }
    // Catalog creation, machine options, and OS discovery can publish together.
    pending = Promise.resolve().then(async () => {
      try {
        while (profiles.size) {
          const batch = [...profiles];
          profiles.clear();
          try {
            const placements = await params.placements.readChangeSnapshot(batch);
            const context = params.getSessionChangeContext?.();
            if (stopped || !context) {
              return;
            }
            for (const placement of placements) {
              emitSessionsChanged(context, {
                reason: "placement",
                sessionKey: placement.sessionKey,
                agentId: placement.agentId,
              });
            }
          } catch (error) {
            try {
              params.warn(
                `Worker machine metadata change reporting failed: ${formatErrorMessage(error)}`,
              );
            } catch {
              // Best-effort reporting must not leak a rejected background operation.
            }
          }
        }
      } finally {
        pending = undefined;
      }
    });
  });
  return async () => {
    stopped = true;
    profiles.clear();
    unsubscribe();
    await pending;
  };
}
