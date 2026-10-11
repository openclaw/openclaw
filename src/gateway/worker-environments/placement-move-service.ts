import { getRuntimeConfig } from "../../config/config.js";
import { assertRequiredWorkerMove } from "../../config/required-worker-profile.js";
import { composePlacementAuthorization } from "./placement-authorization.js";
import type {
  WorkerActiveDispatchPlacement,
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacement,
  WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import type {
  WorkerPlacementMoveIntent,
  WorkerPlacementMoveTarget,
} from "./placement-move-intent.types.js";
import type { WorkerSessionPlacementProjection } from "./placement-read-projection.types.js";
import type { WorkerReclaimPlacement } from "./placement-reclaim-contract.js";
import {
  isCurrentPlacementTurnClaim,
  isForceAbandonedWorkerPlacement,
  projectWorkerSessionTurnClaim,
  reportPlacementTransition,
  type WorkerSessionPlacementIdentity,
} from "./placement-record.js";
import {
  isFailedWorkerPlacementEnvironmentGone,
  matchesWorkerPlacementTarget,
} from "./placement-target.js";
import type {
  WorkerPlacementDispatchRequest,
  WorkerPlacementAuthorization,
  WorkerPlacementMoveDestination,
  WorkerPlacementMoveRequest,
  WorkerPlacementReclaimRequest,
} from "./service-contract.js";
import { isTerminalWorkerEnvironmentState } from "./state.js";

type WorkerMoveBeginResult = {
  intent: WorkerPlacementMoveIntent;
  placement: Extract<WorkerDispatchPlacement, { state: "draining" | "failed" }>;
  joined: boolean;
};
type WorkerMovePlacement = Extract<WorkerDispatchPlacement, { state: "local" | "active" }>;
type WorkerPlacementMoveSourceDisposition = "reconcile" | "abandon";
const RESTART_AUTHORITY_EXPIRED =
  "Cloud worker move request authority expired after Gateway restart; retry move";

export type WorkerPlacementMoveBarrier = (
  params: WorkerSessionPlacementIdentity & {
    authorize?: WorkerPlacementAuthorization;
    signal?: AbortSignal;
    sourceDisposition: WorkerPlacementMoveSourceDisposition;
    begin: (prepareNew?: (runId: string) => Promise<void>) => Promise<WorkerMoveBeginResult>;
  },
) => Promise<WorkerMoveBeginResult>;

export function createWorkerPlacementMoveService(options: {
  placements: WorkerDispatchPlacementStore;
  environments: Pick<WorkerDispatchEnvironmentService, "get">;
  runMoveBarrier: WorkerPlacementMoveBarrier;
  dispatch: (
    request: WorkerPlacementDispatchRequest,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
    authorize?: WorkerPlacementAuthorization,
    signal?: AbortSignal,
  ) => Promise<WorkerActiveDispatchPlacement>;
  reclaimSource: (
    request: WorkerPlacementReclaimRequest,
    intent: WorkerPlacementMoveIntent,
    authorize?: WorkerPlacementAuthorization,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
  ) => Promise<WorkerReclaimPlacement>;
  validateAbandonSource: (
    request: WorkerPlacementMoveRequest,
    placement: WorkerDispatchPlacement | undefined,
  ) => void;
  abandonSource: (
    request: WorkerPlacementReclaimRequest,
    intent: WorkerPlacementMoveIntent,
    authorize?: WorkerPlacementAuthorization,
  ) => Promise<Extract<WorkerDispatchPlacement, { state: "local" }>>;
  resolveDestination: (
    identity: WorkerSessionPlacementIdentity,
    target: WorkerPlacementMoveTarget,
  ) => Promise<WorkerPlacementMoveDestination | undefined>;
  prepareGatewayMove?: (
    params: WorkerSessionPlacementIdentity & { assertCurrent: () => void },
  ) => Promise<void>;
}) {
  const recordError = async (intent: WorkerPlacementMoveIntent, error: unknown): Promise<void> => {
    await options.placements.recordPlacementMoveError({
      operationId: intent.operationId,
      sessionId: intent.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const move = async (
    request: WorkerPlacementMoveRequest,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
    authorize?: WorkerPlacementAuthorization,
    signal?: AbortSignal,
  ): Promise<WorkerMovePlacement> => {
    const assertCurrent = composePlacementAuthorization(authorize, () => {
      signal?.throwIfAborted();
      assertRequiredWorkerMove(getRuntimeConfig(), request.target);
    });
    let intent: WorkerPlacementMoveIntent | undefined;
    let local: WorkerReclaimPlacement | undefined;
    try {
      assertCurrent();
      if (request.abandonSource && request.target.kind !== "gateway") {
        throw new Error("Source abandonment is available only when continuing on the Gateway");
      }
      const destination =
        request.target.kind === "gateway"
          ? undefined
          : await options.resolveDestination(request, request.target);
      if (request.target.kind !== "gateway" && !destination) {
        throw new Error(`Session ${request.sessionKey} worker move target is unavailable`);
      }
      assertCurrent();
      const begun = await options.runMoveBarrier({
        sessionId: request.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        sourceDisposition: request.abandonSource ? "abandon" : "reconcile",
        authorize: assertCurrent,
        signal,
        begin: async (prepareNew) => {
          const moveRequest = {
            sessionId: request.sessionId,
            source: request.source,
            target: request.target,
            ...(request.abandonSource ? { abandonSource: true as const } : {}),
          };
          // Existing durable decisions own retries. Prepare only a new intent, outside
          // the synchronous commit, so both branches publish their owner before yielding.
          if (request.abandonSource) {
            const { placement, move: existingMove } = await options.placements.getWithMoveAsync(
              request.sessionId,
            );
            if (!existingMove) {
              options.validateAbandonSource(request, placement);
              const claim = placement ? projectWorkerSessionTurnClaim(placement) : undefined;
              if (claim && prepareNew) {
                await prepareNew(claim.runId);
                const current = await options.placements.getAsync(request.sessionId);
                if (!current || !isCurrentPlacementTurnClaim(current, claim)) {
                  throw new Error(
                    `Session ${request.sessionKey} abandonment worker turn changed; retry`,
                  );
                }
                options.validateAbandonSource(request, current);
              }
            }
          }
          assertCurrent();
          const started = await options.placements.beginPlacementMove(moveRequest, {
            assertCurrent,
            ...(request.abandonSource
              ? {
                  assertNewSource: (placement) => options.validateAbandonSource(request, placement),
                }
              : {}),
          });
          if (
            started.placement.state !== "draining" &&
            !(request.abandonSource && isForceAbandonedWorkerPlacement(started.placement))
          ) {
            throw new Error(
              `Session ${request.sessionKey} placement move is already in ${started.placement.state}`,
            );
          }
          reportPlacementTransition(onTransition, started.placement);
          return { ...started, placement: started.placement };
        },
      });
      intent = begun.intent;
      local = request.abandonSource
        ? await options.abandonSource(request, intent, assertCurrent)
        : await options.reclaimSource(request, intent, assertCurrent, onTransition);
      if (request.abandonSource) {
        reportPlacementTransition(onTransition, local);
      }
      if (local.state === "reclaimed") {
        assertRequiredWorkerMove(getRuntimeConfig(), intent.target);
      }
      if (local.state !== "local") {
        throw new Error(`Session ${request.sessionKey} move did not return to local placement`);
      }
      if (!destination) {
        return local;
      }
      const active = await options.dispatch(
        {
          sessionId: request.sessionId,
          sessionKey: request.sessionKey,
          agentId: request.agentId,
          ...destination,
          idempotencyKey: `session-move:${intent.operationId}:dispatch`,
        },
        onTransition,
        assertCurrent,
        signal,
      );
      const completed = await options.placements.completePlacementMoveToWorker(
        {
          operationId: intent.operationId,
          sessionId: request.sessionId,
          expectedGeneration: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        { assertCurrent },
      );
      if (completed.state !== "active") {
        throw new Error(`Session ${request.sessionKey} move did not finish active`);
      }
      return completed;
    } catch (error) {
      // Source cleanup is settled. A canceled, unpublished destination leaves this
      // exact local completion for Stop; unrelated errors or replacements still fail.
      if (intent && local?.state === "local" && signal?.aborted && error === signal.reason) {
        const cancelled = await options.placements.cancelPlacementMove({
          operationId: intent.operationId,
          sessionId: request.sessionId,
          expectedLocalGeneration: local.generation,
        });
        if (cancelled) {
          return local;
        }
      }
      const durableIntent =
        intent ?? (await options.placements.getPlacementMoveAsync(request.sessionId));
      if (durableIntent) {
        await recordError(durableIntent, error);
      }
      throw error;
    }
  };

  const recover = async (
    intent: WorkerPlacementMoveIntent,
    initialPlacement: WorkerDispatchPlacement | undefined,
  ): Promise<void> => {
    try {
      let placement = initialPlacement;
      if (!placement) {
        throw new Error(`Session ${intent.sessionId} placement move lost its session placement`);
      }
      const identity = {
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
      };
      const assertDestination = () => assertRequiredWorkerMove(getRuntimeConfig(), intent.target);
      if (intent.abandonSource) {
        if (intent.target.kind !== "gateway") {
          throw new Error(
            `Session ${identity.sessionKey} abandonment intent has a non-Gateway target`,
          );
        }
        if (placement.state === "local") {
          await options.placements.cancelPlacementMove(intent);
          return;
        }
        assertDestination();
        await options.abandonSource(identity, intent, assertDestination);
        return;
      }
      if (placement.state === "failed") {
        if (
          !isFailedWorkerPlacementEnvironmentGone({
            environmentService: options.environments,
            placement,
          })
        ) {
          throw new Error(
            `Session ${identity.sessionKey} failed move environment must finish teardown before retry`,
          );
        }
        await options.placements.cancelPlacementMove(intent);
        return;
      } else if (placement.state === "draining") {
        assertDestination();
        const local = await options.reclaimSource(identity, intent, assertDestination);
        if (local.state === "reclaimed") {
          return;
        }
        if (local.state !== "local") {
          throw new Error(`Session ${identity.sessionKey} move recovery did not return local`);
        }
        placement = local;
      } else if (placement.state === "reconciling") {
        const environment = options.environments.get(placement.environmentId);
        if (environment && !isTerminalWorkerEnvironmentState(environment.state)) {
          return;
        }
        const source = placement;
        const assertCurrent = () => {
          assertDestination();
          const { placement: current, move: currentMove } =
            options.placements.readCurrentMoveAuthority(intent.sessionId);
          if (
            !matchesWorkerPlacementTarget(current, source) ||
            currentMove?.operationId !== intent.operationId
          ) {
            throw new Error(`Session ${identity.sessionKey} move recovery lost its source owner`);
          }
        };
        assertCurrent();
        if (intent.target.kind === "gateway") {
          // Teardown can survive a restart before the source checkout is materialized.
          // Publish local placement only after its accepted repository state exists locally.
          await options.prepareGatewayMove?.({ ...identity, assertCurrent });
          assertCurrent();
        }
        placement = await options.placements.completePlacementMoveSourceToLocal(
          {
            operationId: intent.operationId,
            sessionId: intent.sessionId,
            expectedGeneration: placement.generation,
          },
          { assertCurrent },
        );
      } else if (placement.state === "active") {
        const stillSource =
          placement.environmentId === intent.source.environmentId &&
          placement.activeOwnerEpoch === intent.source.ownerEpoch;
        if (stillSource) {
          throw new Error(`Session ${identity.sessionKey} move recovery found an active source`);
        }
        await options.placements.completePlacementMoveToWorker({
          operationId: intent.operationId,
          sessionId: intent.sessionId,
          expectedGeneration: placement.generation,
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
        });
        return;
      } else if (placement.state !== "local") {
        // Generic dispatch recovery owns requested through starting. A later
        // coordinated sweep either observes active or retries from failed/local.
        return;
      }
      if (intent.target.kind === "gateway") {
        if (await options.placements.getPlacementMoveAsync(intent.sessionId)) {
          await options.placements.cancelPlacementMove(intent);
        }
        return;
      }
      await options.placements.fail({
        sessionId: placement.sessionId,
        expectedGeneration: placement.generation,
        recoveryError: RESTART_AUTHORITY_EXPIRED,
      });
      await options.placements.cancelPlacementMove(intent);
    } catch (error) {
      await recordError(intent, error);
      throw error;
    }
  };

  const recoverSession = async (
    projection: WorkerSessionPlacementProjection,
    environmentId?: string,
  ): Promise<Set<string>> => {
    const protectedSessions = new Set<string>();
    for (const intent of projection.moves.values()) {
      const placement = projection.placements.get(intent.sessionId);
      // Source cleanup can leave a local placement; destination activation keeps the
      // move intent until completion. Either owner must be able to finish that move.
      if (
        environmentId !== undefined &&
        intent.source.environmentId !== environmentId &&
        placement?.environmentId !== environmentId
      ) {
        continue;
      }
      const state = placement?.state;
      if (
        (intent.abandonSource && state !== "local") ||
        state === "draining" ||
        state === "reconciling"
      ) {
        protectedSessions.add(intent.sessionId);
      }
      await recover(intent, placement).catch(() => undefined);
    }
    return protectedSessions;
  };

  return { move, recoverSession };
}
