import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getRepositoryIntegration } from "../../plugins/repository-integration-runtime.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { WORKER_ADMISSION_DEADLINE_MS } from "../../worker/worker-connection-contract.js";
import { GitHubPublicationRecoveryPendingError } from "../github-publication-git-index.js";
import { assertRepositoryDispatchAdmission } from "../repository-dispatch.js";
import type { PrepareRepositoryPublicationIntegration } from "../repository-publication-integration.js";
import { StaleWorkerBuildError } from "./admission.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import type { WorkerDevicePlacementRequirementResolver } from "./placement-dispatch-startup.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import { matchesWorkerPlacementTarget } from "./placement-target.js";
import { WorkerRuntimeRefreshPendingError } from "./provider-runtime-refresh.js";
import { readWorkerProfileSelection } from "./service-validation.js";
import type { WorkerEnvironmentService } from "./service.js";
import { WorkerTunnelOwnerDisconnectedError } from "./tunnel-contract.js";

/** Publication borrows placement recovery and runtime refresh; it never creates a model turn. */
export function createRepositoryPublicationPreparation(params: {
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get" | "startTunnel" | "inspectTurnLease">;
  ensurePlacement: ReturnType<typeof coordinateWorkerPlacementDispatch>["ensurePlacement"];
  resolveDevicePlacementRequirement: WorkerDevicePlacementRequirementResolver;
  getConfig: () => OpenClawConfig;
  waitForNode: (input: {
    placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>;
    signal: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<void>;
  reconcileActive: (environmentId: string) => Promise<unknown>;
}): PrepareRepositoryPublicationIntegration {
  return async (identity, input) => {
    input.assertCurrent();
    const assertDispatch = () => {
      if (getRepositoryIntegration(params.getConfig()) && !input.readNativeCredential?.admit) {
        throw new GitHubPublicationRecoveryPendingError(
          "Worker recovery needs current startup authorization. Retry the same publication from the original signed-in account; its checkpoint is retained.",
        );
      }
      assertRepositoryDispatchAdmission(input.readNativeCredential, params.getConfig());
    };
    let placement = await params.placements.getAsync(identity.sessionId);
    input.assertCurrent();
    if (placement?.state !== "active") {
      assertDispatch();
      const environment = placement?.environmentId
        ? params.environments.get(placement.environmentId)
        : undefined;
      const requiredProfile = params.getConfig().cloudWorkers?.requiredProfile;
      const profileId = environment?.profileId ?? requiredProfile;
      if (!profileId) {
        throw new GitHubPublicationRecoveryPendingError(
          "The saved publication has no recorded worker destination. Choose where the session should continue, then retry the same request.",
        );
      }
      const executionMode = placement?.executionMode ?? "worker-turn";
      const { machineClass, os } = environment
        ? readWorkerProfileSelection(environment.profileSnapshot)
        : {};
      const devicePlacement = environment?.nodeDeviceId
        ? await params.resolveDevicePlacementRequirement({ ...identity, executionMode })
        : undefined;
      input.assertCurrent();
      const prepared = await params.ensurePlacement({
        request: {
          ...identity,
          profileId,
          executionMode,
          runSetupScript: false,
          readNativeCredential: input.readNativeCredential,
          ...(requiredProfile ? { requiredProfile } : {}),
          ...(environment
            ? {
                ...(machineClass ? { machineClass } : {}),
                ...(os ? { os } : {}),
                inheritedProfile: {
                  providerId: environment.providerId,
                  profileSnapshot: environment.profileSnapshot,
                },
              }
            : {}),
          ...(devicePlacement ? { devicePlacement } : {}),
          ...(environment?.providerId === DEVICE_WORKER_PROVIDER_ID && environment.nodeDeviceId
            ? { deviceId: environment.nodeDeviceId }
            : {}),
        },
        assertCurrent: input.assertCurrent,
        authorizeDispatch: input.assertCurrent,
        prepareWorkspace: async (canPrepare) => {
          input.assertCurrent();
          if (!canPrepare()) {
            throw new GitHubPublicationRecoveryPendingError(
              "Publication worker preparation is busy; retry the same request.",
            );
          }
        },
        waitForReady: true,
      });
      try {
        prepared.assertCurrent();
        input.assertCurrent();
        placement = params.placements.get(identity.sessionId);
      } finally {
        prepared.release();
      }
    }
    if (placement?.state !== "active") {
      throw new GitHubPublicationRecoveryPendingError(
        "Publication is waiting for its worker placement; retry the same request.",
      );
    }
    const selected = placement;
    const assertCurrent = () => {
      input.assertCurrent();
      const current = params.placements.get(identity.sessionId);
      if (
        !matchesWorkerPlacementTarget(current, selected) ||
        current?.sessionKey !== identity.sessionKey ||
        current.agentId !== identity.agentId
      ) {
        throw new GitHubPublicationRecoveryPendingError(
          "Publication lost its worker placement; retry the same request after recovery.",
        );
      }
    };
    let openingTunnel = true;
    const integrate = async () => {
      const tunnel = await params.environments.startTunnel({
        environmentId: selected.environmentId,
        ownerEpoch: selected.activeOwnerEpoch,
        authorize: assertCurrent,
      });
      openingTunnel = false;
      assertCurrent();
      if (!tunnel.integratePublication) {
        throw new StaleWorkerBuildError();
      }
      return await tunnel.integratePublication({ ...input, assertCurrent });
    };
    try {
      return await integrate();
    } catch (error) {
      // A disconnected open has no publication effects. Never replay a failed transfer.
      if (
        !(
          error instanceof StaleWorkerBuildError ||
          error instanceof WorkerRuntimeRefreshPendingError ||
          (openingTunnel && error instanceof WorkerTunnelOwnerDisconnectedError)
        )
      ) {
        throw error;
      }
      const facts = await params.placements.prepareRuntimeRefresh(identity.sessionId);
      const assertRefresh = () => {
        assertCurrent();
        assertDispatch();
        facts.assertCurrent();
        if (
          params.placements.get(identity.sessionId)?.turnClaim ||
          facts.pendingResult ||
          facts.move
        ) {
          throw new GitHubPublicationRecoveryPendingError(
            "Publication is waiting for current worker work to settle before runtime recovery; its checkpoint is retained.",
          );
        }
      };
      try {
        assertRefresh();
        await input.readNativeCredential?.admit?.();
        assertRefresh();
        const signal = AbortSignal.any([
          getGatewayRestartDrainSignal(),
          AbortSignal.timeout(WORKER_ADMISSION_DEADLINE_MS),
        ]);
        const environment = params.environments.get(selected.environmentId);
        if (environment?.retention) {
          if (!environment.leaseId) {
            throw new GitHubPublicationRecoveryPendingError(
              "Publication is waiting for its retained worker lease.",
            );
          }
          await params.environments.inspectTurnLease({
            environmentId: selected.environmentId,
            ownerEpoch: selected.activeOwnerEpoch,
            leaseId: environment.leaseId,
            signal,
            assertCurrent: assertRefresh,
          });
          assertRefresh();
        }
        await params.waitForNode({ placement: selected, signal, assertCurrent: assertRefresh });
        assertRefresh();
      } finally {
        facts.release();
      }
      assertCurrent();
      await params.reconcileActive(selected.environmentId);
      assertCurrent();
      try {
        return await integrate();
      } catch (refreshError) {
        if (
          refreshError instanceof StaleWorkerBuildError ||
          refreshError instanceof WorkerRuntimeRefreshPendingError
        ) {
          throw new GitHubPublicationRecoveryPendingError(
            "Publication is waiting for normal worker runtime recovery; retry the same request.",
            { cause: refreshError },
          );
        }
        throw refreshError;
      }
    }
  };
}
