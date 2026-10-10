import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import type { OpenClawConfig } from "../../config/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isSessionWorkAdmissionActive } from "../../sessions/session-lifecycle-admission.js";
import type { WorkerPlacementDispatchService } from "./placement-dispatch.js";
import type { WorkerSessionPlacementIdentity } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";

class WorkerPlacementAutoSuspendBusyError extends Error {}

export function createWorkerPlacementIdleSweep(options: {
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get">;
  dispatch: Pick<WorkerPlacementDispatchService, "reclaim">;
  reportChanges: (operation: () => Promise<void>) => Promise<void>;
  getConfig: () => OpenClawConfig;
  info: (message: string) => void;
  warn: (message: string) => void;
  isPlacementOperationInFlight?: (sessionId: string) => boolean;
  getSessionWorkAdmissionCheck?: (
    identity: WorkerSessionPlacementIdentity,
  ) => Promise<() => boolean>;
  loadSessionRuntime?: () => Promise<
    Pick<typeof import("../session-utils.js"), "resolveGatewaySessionStoreTargetWithStore">
  >;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const loadSessionRuntime = options.loadSessionRuntime;
  const getSessionWorkAdmissionCheck =
    options.getSessionWorkAdmissionCheck ??
    (loadSessionRuntime &&
      (async ({ sessionId, sessionKey, agentId }: WorkerSessionPlacementIdentity) => {
        const sessionRuntime = await loadSessionRuntime();
        const target = sessionRuntime.resolveGatewaySessionStoreTargetWithStore({
          cfg: options.getConfig(),
          key: sessionKey,
          agentId,
          clone: false,
        });
        const identities = [sessionKey, target.canonicalKey, ...target.storeKeys, sessionId];
        return () =>
          isSessionWorkAdmissionActive(target.storePath, identities) ||
          hasPendingFollowupQueueWork(identities);
      }));

  return {
    async sweep(): Promise<void> {
      const profiles = options.getConfig().cloudWorkers?.profiles;
      if (!profiles || !Object.values(profiles).some((profile) => profile.suspendAfter)) {
        return;
      }
      await options.reportChanges(async () => {
        const candidates = await options.placements.readRecoveryCandidates();
        const projection = await options.placements.readProjection(
          candidates.map(({ sessionId }) => sessionId),
          { current: true },
        );

        for (const { sessionId } of candidates) {
          const placement = projection.placements.get(sessionId);
          if (placement?.state !== "active" || placement.turnClaim) {
            continue;
          }
          const environment = options.environments.get(placement.environmentId);
          const suspendAfter = environment && profiles[environment.profileId]?.suspendAfter;
          if (!environment || !suspendAfter) {
            continue;
          }
          // Placement activation and every turn-claim admission/release durably refresh this fact.
          if (now() - placement.updatedAtMs < parseDurationMs(suspendAfter)) {
            continue;
          }
          if (
            projection.workspaceRecoveryPendingSessionIds.has(placement.sessionId) ||
            projection.moves.has(placement.sessionId) ||
            options.isPlacementOperationInFlight?.(placement.sessionId)
          ) {
            continue;
          }

          try {
            const request = {
              sessionId: placement.sessionId,
              sessionKey: placement.sessionKey,
              agentId: placement.agentId,
            };
            const hasSessionWork = await getSessionWorkAdmissionCheck?.(request);
            const assertCurrent = () => {
              if (
                options.getConfig().cloudWorkers?.profiles?.[environment.profileId]
                  ?.suspendAfter !== suspendAfter ||
                hasSessionWork?.()
              ) {
                throw new WorkerPlacementAutoSuspendBusyError();
              }
            };
            const beforeDrain = Object.assign(
              () => {
                assertCurrent();
                const current = options.placements.get(placement.sessionId);
                if (
                  current?.state !== "active" ||
                  current.generation !== placement.generation ||
                  current.environmentId !== placement.environmentId ||
                  current.activeOwnerEpoch !== placement.activeOwnerEpoch ||
                  current.updatedAtMs !== placement.updatedAtMs ||
                  current.turnClaim
                ) {
                  throw new WorkerPlacementAutoSuspendBusyError();
                }
              },
              { assertCurrent },
            );
            await options.dispatch.reclaim(request, undefined, beforeDrain);
            options.info(
              `auto-suspended ${placement.sessionKey} after ${suspendAfter} idle; wakes on next message`,
            );
          } catch (error) {
            if (error instanceof WorkerPlacementAutoSuspendBusyError) {
              continue;
            }
            options.warn(
              `Worker auto-suspend failed (${placement.sessionKey}): ${formatErrorMessage(error)}`,
            );
          }
        }
      });
    },
  };
}
