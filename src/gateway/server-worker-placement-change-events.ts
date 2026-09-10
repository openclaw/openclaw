import { formatErrorMessage } from "../infra/errors.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import { readWorkerPlacementIdentity } from "./worker-environments/placement-projector.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

export function createGatewayWorkerPlacementChangePublisher(params: {
  placements: Pick<WorkerSessionPlacementStore, "list">;
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
  const snapshotPlacements = () =>
    new Map(
      params.placements.list().map((placement) => [
        placement.sessionId,
        {
          state: placement.state,
          generation: placement.generation,
          updatedAtMs: placement.updatedAtMs,
          sessionKey: placement.sessionKey,
          agentId: placement.agentId,
        },
      ]),
    );

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    let context: ReturnType<NonNullable<typeof params.getSessionChangeContext>>;
    let before: ReturnType<typeof snapshotPlacements> | undefined;
    try {
      context = params.getSessionChangeContext?.();
      if (context) {
        before = snapshotPlacements();
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
        const after = snapshotPlacements();
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
  placements: Pick<WorkerSessionPlacementStore, "list">;
  environments: Pick<
    WorkerEnvironmentService,
    "get" | "readMachineShape" | "subscribeMachineShapeChanged"
  >;
  getSessionChangeContext?: () => Parameters<typeof emitSessionsChanged>[0] | undefined;
}) {
  return params.environments.subscribeMachineShapeChanged((profileId) => {
    const context = params.getSessionChangeContext?.();
    if (!context) {
      return;
    }
    for (const placement of params.placements.list()) {
      if (readWorkerPlacementIdentity(placement, params.environments)?.profileId === profileId) {
        emitSessionsChanged(context, {
          reason: "placement",
          sessionKey: placement.sessionKey,
          agentId: placement.agentId,
        });
      }
    }
  });
}
