import {
  projectWorkerPlacementMove,
  projectWorkerSessionPlacement,
  readWorkerPlacementIdentity,
} from "../worker-environments/placement-projector.js";
import type { WorkerSessionPlacementProjection } from "../worker-environments/placement-read-projection.js";
import { isFailedWorkerPlacementEnvironmentGone } from "../worker-environments/session-placement-lifecycle.js";
import type { GatewayRequestContext } from "./types.js";

export type SessionPlacementReadContext = Pick<
  GatewayRequestContext,
  | "workerSessionPlacementService"
  | "workerEnvironmentService"
  | "workerPlacementDiskSpaceReader"
  | "workerPlacementRunnerAvailabilityReader"
>;

function projectSessionPlacementFields(params: {
  context: SessionPlacementReadContext;
  sessionId: string | undefined;
  snapshot?: WorkerSessionPlacementProjection;
}) {
  const placement = params.sessionId
    ? params.snapshot?.placements.get(params.sessionId)
    : undefined;
  const move = params.sessionId ? params.snapshot?.moves.get(params.sessionId) : undefined;
  const environment = placement?.environmentId
    ? (params.snapshot?.environments.get(placement.environmentId) ?? null)
    : null;
  const failedRecoveryAction =
    placement?.state === "failed"
      ? isFailedWorkerPlacementEnvironmentGone({
          environmentService: params.context.workerEnvironmentService,
          placement,
          preparedEnvironment: environment,
        })
        ? "restart"
        : "stop-first"
      : undefined;
  return {
    ...(placement
      ? {
          placement: projectWorkerSessionPlacement(
            placement,
            params.context.workerPlacementDiskSpaceReader?.read(placement),
            params.context.workerPlacementRunnerAvailabilityReader?.read(placement, environment),
            readWorkerPlacementIdentity(
              placement,
              params.context.workerEnvironmentService,
              environment,
            ),
            failedRecoveryAction,
            params.snapshot?.workspaceResultReconcilingSessionIds.has(placement.sessionId) ?? false,
          ),
        }
      : {}),
    ...(move ? { placementMove: projectWorkerPlacementMove(move) } : {}),
  };
}

export async function createSessionPlacementBatchProjector(
  context: SessionPlacementReadContext,
  sessions: readonly { sessionId?: string }[],
) {
  const sessionIds = sessions.flatMap((session) => (session.sessionId ? [session.sessionId] : []));
  const service = context.workerSessionPlacementService;
  if (service && !service.readProjection) {
    throw new Error("Worker placement projection is unavailable");
  }
  const snapshot = await service?.readProjection?.(sessionIds);
  return (sessionId: string | undefined) =>
    projectSessionPlacementFields({
      context,
      sessionId,
      snapshot,
    });
}

export async function readSessionPlacementFields(
  context: SessionPlacementReadContext,
  sessionId: string | undefined,
) {
  const project = await createSessionPlacementBatchProjector(
    context,
    sessionId ? [{ sessionId }] : [{}],
  );
  return project(sessionId);
}
