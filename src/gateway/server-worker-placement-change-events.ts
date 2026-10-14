import { formatErrorMessage } from "../infra/errors.js";
import { emitSessionsChanged } from "./server-methods/session-change-event.js";
import type { WorkerPlacementRunnerAvailabilityReader } from "./worker-environments/placement-projector.js";
import type { WorkerSessionPlacementIdentity } from "./worker-environments/placement-record.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";

export function createGatewayWorkerPlacementChangePublisher(params: {
  placements: Pick<WorkerSessionPlacementStore, "subscribeChanges">;
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
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    let context: ReturnType<NonNullable<typeof params.getSessionChangeContext>>;
    try {
      context = params.getSessionChangeContext?.();
    } catch (error) {
      warnPlacementChangeFailure(error);
    }
    if (!context) {
      return await operation();
    }
    const changed = new Map<string, WorkerSessionPlacementIdentity>();
    const unsubscribe = params.placements.subscribeChanges((placement) => {
      changed.set(placement.sessionId, placement);
    });
    try {
      return await operation();
    } finally {
      unsubscribe();
      for (const placement of changed.values()) {
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
    }
  };
}

export function subscribeGatewayWorkerPlacementMetadataChanges(params: {
  placements: Pick<WorkerSessionPlacementStore, "readChangeSnapshot" | "readProjection">;
  environments: Pick<WorkerEnvironmentService, "subscribeMachineShapeChanged">;
  runnerAvailability: WorkerPlacementRunnerAvailabilityReader;
  getSessionChangeContext?: () => Parameters<typeof emitSessionsChanged>[0] | undefined;
  warn: (message: string) => void;
}) {
  const profiles = new Set<string>();
  const nodes = new Set<string>();
  let stopped = false;
  let pending: Promise<void> | undefined;
  const schedule = () => {
    if (stopped || !params.getSessionChangeContext?.()) {
      return;
    }
    if (pending) {
      return;
    }
    // Catalog creation, machine options, and OS discovery can publish together.
    pending = Promise.resolve().then(async () => {
      try {
        while (profiles.size || nodes.size) {
          const batch = [...profiles];
          const changedNodes = new Set(nodes);
          profiles.clear();
          nodes.clear();
          try {
            const placements = new Map(
              (batch.length ? await params.placements.readChangeSnapshot(batch) : []).map(
                (placement) => [placement.sessionId, placement],
              ),
            );
            if (changedNodes.size) {
              const identities = await params.placements.readChangeSnapshot();
              const projection = await params.placements.readProjection(
                identities.filter((row) => row.state === "active").map((row) => row.sessionId),
                { current: true },
              );
              for (const placement of projection.placements.values()) {
                const runner = params.runnerAvailability.read(
                  placement,
                  projection.environments.get(placement.environmentId ?? "") ?? null,
                );
                if (runner?.deviceId && changedNodes.has(runner.deviceId)) {
                  placements.set(placement.sessionId, placement);
                }
              }
            }
            const context = params.getSessionChangeContext?.();
            if (stopped || !context) {
              return;
            }
            for (const placement of placements.values()) {
              emitSessionsChanged(
                context,
                {
                  reason: "placement",
                  sessionKey: placement.sessionKey,
                  sessionId: placement.sessionId,
                  agentId: placement.agentId,
                },
                { accessChanged: false },
              );
            }
          } catch (error) {
            try {
              params.warn(
                `Worker placement metadata change reporting failed: ${formatErrorMessage(error)}`,
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
  };
  const unsubscribe = params.environments.subscribeMachineShapeChanged((profileId) => {
    profiles.add(profileId);
    schedule();
  });
  return {
    runnerChanged(nodeId: string) {
      if (stopped) {
        return;
      }
      nodes.add(nodeId);
      schedule();
    },
    async stop() {
      stopped = true;
      profiles.clear();
      nodes.clear();
      unsubscribe();
      await pending;
    },
  };
}
