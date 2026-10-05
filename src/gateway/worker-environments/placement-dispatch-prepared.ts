import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { supportsCurrentWorkerLaunch } from "./admission.js";
import type { WorkerNodePlacementAuthority } from "./device-placement-eligibility.js";
import {
  MAX_PREPARED_CANDIDATE_OBSERVATIONS,
  recordPreparedCandidateRejection,
  recordWorkerPlacementAwait,
  recordWorkerPlacementStage,
  type PreparedCandidateRejectionCode,
} from "./placement-diagnostics.js";
import type {
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacement,
  WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import {
  readWorkerProjectPreparation,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";

export type WorkerNodePlacementAdmission = {
  node: NodeWorkerSupervisorNodeProof;
  requirement: DevicePlacementRequirement;
};

export function createWorkerPreparedPlacementBinder(options: {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService;
  requireNodePlacementEligibility: (
    request: WorkerPlacementDispatchRequest,
    environment: Awaited<ReturnType<WorkerEnvironmentService["createWithRequest"]>>,
  ) => Promise<WorkerNodePlacementAdmission | undefined>;
  isCurrentNodePlacement?: WorkerNodePlacementAuthority;
}) {
  const { placements, environments, requireNodePlacementEligibility } = options;
  return async (params: {
    request: WorkerPlacementDispatchRequest;
    placement: WorkerDispatchPlacement;
    intent: WorkerProviderPreparedIntent;
    workspace: WorkerSessionWorkspace;
    assertCurrent: () => void;
  }) => {
    const preparation = readWorkerProjectPreparation(params.intent.profileSnapshot.project);
    if (!preparation || params.intent.preparationKey !== preparation.key) {
      return undefined;
    }
    const assertCurrent = () => {
      params.assertCurrent();
      environments.assertPreparedIntentCurrent(params.request.profileId, params.intent);
    };
    assertCurrent();
    await recordWorkerPlacementAwait(
      params.request.sessionId,
      "prepared_repository_revalidation",
      async () => {
        await environments.revalidatePreparedIntentRepository(
          params.request.profileId,
          params.intent,
        );
        assertCurrent();
      },
      { generation: params.placement.generation },
      "dispatch",
    );
    const expectedBuild = {
      bundleHash: preparation.artifacts.workerBundleHash,
      openclawVersion: preparation.artifacts.openclawVersion,
      protocolFeatures: preparation.artifacts.protocolFeatures,
    };
    let rejectedCount = 0;
    const reject = (environmentId: string, code: PreparedCandidateRejectionCode) => {
      rejectedCount += 1;
      if (rejectedCount <= MAX_PREPARED_CANDIDATE_OBSERVATIONS) {
        recordPreparedCandidateRejection(params.request.sessionId, environmentId, code);
      }
    };
    recordWorkerPlacementStage(params.request.sessionId, "prepared_selection_started", {
      generation: params.placement.generation,
      preparationKey: params.intent.preparationKey,
    });
    const candidates = environments.getPreparedCandidates(
      params.intent,
      params.request.profileId,
      reject,
    );
    const selected = (environmentId?: string) =>
      recordWorkerPlacementStage(params.request.sessionId, "prepared_selection_completed", {
        generation: params.placement.generation,
        candidateCount: candidates.length,
        rejectedCount,
        environmentId,
        prepared: environmentId !== undefined,
      });
    for (const environment of candidates) {
      const project = readWorkerProjectSnapshot(environment.profileSnapshot.project);
      const reservePreparation = readWorkerProjectPreparation(environment.profileSnapshot.project);
      if (!reservePreparation) {
        reject(environment.environmentId, "preparation_missing");
        continue;
      }
      if (
        params.workspace.kind === "repository" &&
        params.workspace.repository.baseCommit &&
        project &&
        "source" in project &&
        project.baseCommit !== params.workspace.repository.baseCommit
      ) {
        reject(environment.environmentId, "repository_base_mismatch");
        continue;
      }
      if (!environment.nodeDeviceId) {
        reject(environment.environmentId, "node_missing");
        continue;
      }
      if (!environment.leaseId) {
        reject(environment.environmentId, "lease_missing");
        continue;
      }
      if (!environment.bootstrapReceipt) {
        reject(environment.environmentId, "bootstrap_missing");
        continue;
      }
      if (!supportsCurrentWorkerLaunch(environment.bootstrapReceipt)) {
        reject(environment.environmentId, "launch_protocol_mismatch");
        continue;
      }
      if (!sameWorkerBuild(environment.bootstrapReceipt, expectedBuild)) {
        reject(environment.environmentId, "build_mismatch");
        continue;
      }
      let admittedNode: Awaited<ReturnType<typeof requireNodePlacementEligibility>>;
      try {
        admittedNode = await requireNodePlacementEligibility(params.request, environment);
      } catch {
        // An unavailable spare is a capacity miss; cancellation or revoked request authority is not.
        assertCurrent();
        reject(environment.environmentId, "node_admission_unavailable");
        continue;
      }
      assertCurrent();
      const remainsSelectable = () =>
        environments
          .getPreparedCandidates(params.intent, params.request.profileId)
          .some(
            (candidate) =>
              candidate.environmentId === environment.environmentId &&
              candidate.ownerEpoch === environment.ownerEpoch,
          );
      if (!admittedNode) {
        reject(environment.environmentId, "node_admission_unavailable");
        continue;
      }
      if (
        !options.isCurrentNodePlacement?.(
          admittedNode.node,
          admittedNode.requirement,
          params.request.executionMode,
        )
      ) {
        reject(environment.environmentId, "node_authority_changed");
        continue;
      }
      if (!remainsSelectable()) {
        reject(environment.environmentId, "candidate_changed");
        continue;
      }
      const { node, requirement } = admittedNode;
      const placement = await placements.bindPreparedEnvironment({
        sessionId: params.request.sessionId,
        sessionKey: params.request.sessionKey,
        agentId: params.request.agentId,
        executionMode: params.request.executionMode,
        expectedGeneration: params.placement.generation,
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        providerId: params.intent.providerId,
        profileId: params.request.profileId,
        preparationKey: reservePreparation.key,
        nodeDeviceId: environment.nodeDeviceId,
        leaseId: environment.leaseId,
        bundleHash: expectedBuild.bundleHash,
        assertCurrent: () => {
          assertCurrent();
          // Pool policy can change while node admission waits; recheck it at consumption.
          if (!remainsSelectable()) {
            throw new Error("Prepared worker is no longer available under the current pool policy");
          }
          if (!options.isCurrentNodePlacement?.(node, requirement, params.request.executionMode)) {
            throw new Error("Prepared worker lost its current node authority before binding");
          }
        },
      });
      if (placement) {
        recordWorkerPlacementStage(params.request.sessionId, "prepared_claimed", {
          generation: placement.generation,
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
        });
        selected(environment.environmentId);
        return { placement, environment, admittedNode };
      }
      reject(environment.environmentId, "claim_conflict");
    }
    selected();
    return undefined;
  };
}
