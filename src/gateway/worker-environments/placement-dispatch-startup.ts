import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { WorkerDispatchTargetChangedError } from "../server-worker-placement-session-target.js";
import {
  supportsWorkerExecutionContextLaunch,
  verifyWorkerAdmissionHandshake,
} from "./admission.js";
import { resolveDevicePlacementEligibility } from "./device-placement-eligibility.js";
import {
  requireProvisionedEnvironment,
  type WorkerActivationBarrier,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchEnvironmentService,
  type WorkerDispatchPlacement,
  type WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import {
  readWorkerProjectPreparation,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import { syncSessionRepositoryWorkspace } from "./repository-workspace-startup.js";
import {
  WorkerPlacementAdmissionTargetError,
  type WorkerPlacementAuthorization,
  type WorkerPlacementDispatchRequest,
} from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";

export type WorkerDevicePlacementRequirementResolver = (
  identity: Pick<
    WorkerPlacementDispatchRequest,
    "sessionId" | "sessionKey" | "agentId" | "executionMode"
  >,
) => Promise<DevicePlacementRequirement>;

export type WorkerNodePlacementAuthority = (
  node: NodeWorkerSupervisorNodeProof,
  requirement: DevicePlacementRequirement,
) => boolean;

type WorkerNodePlacementAdmission = {
  node: NodeWorkerSupervisorNodeProof;
  requirement: DevicePlacementRequirement;
};

function isPendingProvisioningEnvironment(
  environment: ReturnType<WorkerEnvironmentService["get"]>,
  environmentId: string | null,
): boolean {
  return (
    environment?.environmentId === environmentId &&
    environment.destroyRequestedAtMs === null &&
    (environment.state === "requested" ||
      environment.state === "provisioning" ||
      environment.state === "bootstrapping")
  );
}

export function createWorkerPlacementDispatchStartup(options: {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService & Pick<WorkerEnvironmentService, "recordError">;
  isShuttingDown?: () => boolean;
  runActivationBarrier: WorkerActivationBarrier;
  onActivated?: (request: WorkerPlacementDispatchRequest) => void;
  resolveGitAuthor?: (agentId: string) => { name?: string; email?: string } | undefined;
  resolveDevicePlacementRequirement?: WorkerDevicePlacementRequirementResolver;
  isCurrentNodePlacement?: WorkerNodePlacementAuthority;
  reportTransition: (
    observer: ((placement: WorkerDispatchPlacement) => void) | undefined,
    placement: WorkerDispatchPlacement,
  ) => void;
}) {
  const { environments, placements } = options;

  const retainInterruptedProvisioning = (
    owned: WorkerDispatchPlacement,
    error: unknown,
  ): WorkerDispatchPlacement | undefined => {
    const current = placements.get(owned.sessionId);
    if (
      error instanceof WorkerPlacementAdmissionTargetError ||
      error instanceof WorkerDispatchTargetChangedError ||
      !options.isShuttingDown?.() ||
      current?.state !== "provisioning" ||
      current.state !== owned.state ||
      current.generation !== owned.generation ||
      current.environmentId !== owned.environmentId ||
      current.sessionKey !== owned.sessionKey ||
      current.agentId !== owned.agentId ||
      current.executionMode !== owned.executionMode
    ) {
      return undefined;
    }
    const environment = current.environmentId ? environments.get(current.environmentId) : undefined;
    if (!environment || !isPendingProvisioningEnvironment(environment, current.environmentId)) {
      return undefined;
    }
    // No await between owner validation and recording: shutdown retains this exact operation,
    // while explicit Stop's durable destroy intent must always win.
    environments.recordError(environment, error);
    return current;
  };

  const validateDevicePlacement = async (request: WorkerPlacementDispatchRequest) => {
    if (!request.deviceId) {
      return;
    }
    const eligibility = await resolveDevicePlacementEligibility({
      environmentService: environments,
      deviceId: request.deviceId,
      requirement: request.devicePlacement,
      config: getRuntimeConfig(),
    });
    if (!eligibility.ok) {
      throw new Error(eligibility.error);
    }
  };
  const requireNodePlacementEligibility = async (
    request: WorkerPlacementDispatchRequest,
    environment: Awaited<ReturnType<WorkerEnvironmentService["create"]>>,
    admittedNode?: NodeWorkerSupervisorNodeProof,
  ): Promise<WorkerNodePlacementAdmission | undefined> => {
    const deviceId = environment.nodeDeviceId;
    if (!deviceId) {
      return undefined;
    }
    const requirement =
      request.devicePlacement ??
      (options.resolveDevicePlacementRequirement
        ? await options.resolveDevicePlacementRequirement({
            sessionId: request.sessionId,
            sessionKey: request.sessionKey,
            agentId: request.agentId,
            executionMode: request.executionMode,
          })
        : undefined);
    if (!requirement) {
      throw new Error("Node-backed cloud placement has no authoritative runtime requirement");
    }
    const eligibility = await resolveDevicePlacementEligibility({
      environmentService: environments,
      deviceId,
      requirement,
      config: getRuntimeConfig(),
      ...(admittedNode ? { currentNode: admittedNode } : {}),
    });
    if (!eligibility.ok) {
      throw new Error(eligibility.error);
    }
    return { node: eligibility.node, requirement };
  };

  const bindPreparedPlacement = async (params: {
    request: WorkerPlacementDispatchRequest;
    placement: WorkerDispatchPlacement;
    intent: WorkerProviderPreparedIntent;
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
    const expectedBuild = {
      bundleHash: preparation.artifacts.workerBundleHash,
      openclawVersion: preparation.artifacts.openclawVersion,
      protocolFeatures: preparation.artifacts.protocolFeatures,
    };
    for (const environment of environments.getPreparedCandidates(params.intent)) {
      if (
        !environment.nodeDeviceId ||
        !environment.leaseId ||
        !environment.bootstrapReceipt ||
        !supportsWorkerExecutionContextLaunch(environment.bootstrapReceipt) ||
        !verifyWorkerAdmissionHandshake(environment.bootstrapReceipt, expectedBuild)
      ) {
        continue;
      }
      let admittedNode: Awaited<ReturnType<typeof requireNodePlacementEligibility>>;
      try {
        admittedNode = await requireNodePlacementEligibility(params.request, environment);
      } catch {
        // An unavailable spare is a capacity miss; cancellation or revoked request authority is not.
        assertCurrent();
        continue;
      }
      assertCurrent();
      const remainsSelectable = () =>
        environments
          .getPreparedCandidates(params.intent)
          .some(
            (candidate) =>
              candidate.environmentId === environment.environmentId &&
              candidate.ownerEpoch === environment.ownerEpoch,
          );
      if (
        !admittedNode ||
        !options.isCurrentNodePlacement?.(admittedNode.node, admittedNode.requirement) ||
        !remainsSelectable()
      ) {
        continue;
      }
      const { node, requirement } = admittedNode;
      const placement = placements.bindPreparedEnvironment({
        sessionId: params.request.sessionId,
        sessionKey: params.request.sessionKey,
        agentId: params.request.agentId,
        executionMode: params.request.executionMode,
        expectedGeneration: params.placement.generation,
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        providerId: params.intent.providerId,
        profileId: params.request.profileId,
        preparationKey: preparation.key,
        nodeDeviceId: environment.nodeDeviceId,
        leaseId: environment.leaseId,
        bundleHash: expectedBuild.bundleHash,
        assertCurrent: () => {
          assertCurrent();
          // Pool policy can change while node admission waits; recheck it at consumption.
          if (!remainsSelectable()) {
            throw new Error("Prepared worker is no longer available under the current pool policy");
          }
          if (!options.isCurrentNodePlacement?.(node, requirement)) {
            throw new Error("Prepared worker lost its current node authority before binding");
          }
        },
      });
      if (placement) {
        return { placement, environment, admittedNode };
      }
    }
    return undefined;
  };

  const continueProvisionedDispatch = async (params: {
    request: WorkerPlacementDispatchRequest;
    placement: WorkerDispatchPlacement;
    environment: Awaited<ReturnType<WorkerEnvironmentService["create"]>>;
    expectedEnvironmentId: string;
    workspace: WorkerSessionWorkspace;
    onTransition?: (placement: WorkerDispatchPlacement) => void;
    authorize?: WorkerPlacementAuthorization;
    signal?: AbortSignal;
    admittedNode?: WorkerNodePlacementAdmission;
  }): Promise<WorkerActiveDispatchPlacement> => {
    if (params.placement.state !== "provisioning") {
      throw new Error("Worker dispatch continuation requires a provisioning placement");
    }
    const { request } = params;
    params.signal?.throwIfAborted();
    const provisioned = requireProvisionedEnvironment(
      params.environment,
      params.expectedEnvironmentId,
      request.executionMode,
      environments,
    );
    const admittedNode =
      params.admittedNode ?? (await requireNodePlacementEligibility(request, params.environment));
    // Provisioning and transport setup yield; revoked callers must not attach or upload.
    params.signal?.throwIfAborted();
    params.authorize?.();
    let placement = placements.transition({
      sessionId: request.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: params.placement.generation,
      patch: {
        environmentId: provisioned.environmentId,
        workerBundleHash: provisioned.bundleHash,
      },
    });
    options.reportTransition(params.onTransition, placement);
    params.signal?.throwIfAborted();
    const syncingPlacement = placement;
    const assertAttachmentCurrent = () => {
      params.signal?.throwIfAborted();
      params.authorize?.();
      const current = placements.get(request.sessionId);
      if (
        current?.state !== "syncing" ||
        current.generation !== syncingPlacement.generation ||
        current.sessionKey !== request.sessionKey ||
        current.agentId !== request.agentId ||
        current.executionMode !== request.executionMode ||
        current.environmentId !== provisioned.environmentId ||
        current.turnClaim !== null
      ) {
        throw new Error("Worker workspace preparation lost its exact placement owner");
      }
      if (
        admittedNode &&
        !options.isCurrentNodePlacement?.(admittedNode.node, admittedNode.requirement)
      ) {
        throw new Error("Worker dispatch lost its current node authority before attachment");
      }
    };
    const credential = await environments.attachSession({
      environmentId: provisioned.environmentId,
      ownerEpoch: provisioned.ownerEpoch,
      sessionId: request.sessionId,
      ...(params.environment.preparation
        ? {
            placementBinding: {
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
              agentId: request.agentId,
              executionMode: request.executionMode,
              generation: placement.generation,
              preparationKey: params.environment.preparation.key,
              assertCurrent: assertAttachmentCurrent,
            },
          }
        : {}),
      authorize: params.authorize,
    });
    params.signal?.throwIfAborted();
    params.authorize?.();
    const ownerEpoch = credential.ownerEpoch;
    let activated = false;
    let stoppingTunnel: Promise<void> | undefined;
    const stopAttemptTunnel = () => {
      stoppingTunnel ??= environments.stopTunnel(provisioned.environmentId, ownerEpoch);
      void stoppingTunnel.catch(() => undefined);
    };
    params.signal?.addEventListener("abort", stopAttemptTunnel, { once: true });
    try {
      const tunnel = await environments.startTunnel({
        environmentId: provisioned.environmentId,
        ownerEpoch,
        ...(params.authorize ? { authorize: params.authorize } : {}),
      });
      params.signal?.throwIfAborted();
      params.authorize?.();
      const gitAuthor = options.resolveGitAuthor?.(request.agentId);
      const project = readWorkerProjectSnapshot(params.environment.profileSnapshot.project);
      const requireAttachedEnvironment = () => {
        params.signal?.throwIfAborted();
        const attachedEnvironment = environments.get(provisioned.environmentId);
        if (
          !attachedEnvironment ||
          attachedEnvironment.state !== "attached" ||
          attachedEnvironment.destroyRequestedAtMs !== null ||
          attachedEnvironment.ownerEpoch !== ownerEpoch ||
          attachedEnvironment.attachedSessionIds.length !== 1 ||
          attachedEnvironment.attachedSessionIds[0] !== request.sessionId ||
          attachedEnvironment.nodeDeviceId !== params.environment.nodeDeviceId ||
          attachedEnvironment.leaseId !== params.environment.leaseId ||
          attachedEnvironment.bootstrapReceipt?.bundleHash !== provisioned.bundleHash
        ) {
          throw new Error("Worker dispatch lost its exact environment owner before activation");
        }
        return attachedEnvironment;
      };
      const assertSyncOwner = () => {
        assertAttachmentCurrent();
        requireAttachedEnvironment();
      };
      const preparation = readWorkerProjectPreparation(params.environment.profileSnapshot.project);
      let preparedRepository: Parameters<
        typeof syncSessionRepositoryWorkspace
      >[0]["preparedRepository"];
      if (preparation) {
        const prepared = await environments.bindPreparedWorkspace({
          environmentId: provisioned.environmentId,
          ownerEpoch,
          sessionId: request.sessionId,
          sessionKey: request.sessionKey,
          preparationKey: preparation.key,
          cacheKey: preparation.cacheKey,
          signal: params.signal,
          assertCurrent: assertSyncOwner,
        });
        assertSyncOwner();
        if (project && "source" in project) {
          if (
            params.workspace.kind !== "repository" ||
            project.source.url !== params.workspace.repository.url
          ) {
            throw new Error("Prepared repository does not match this session's source");
          }
          preparedRepository = {
            baseCommit: project.baseCommit,
            workspaceDir: prepared.workspaceDir,
            sourceManifestRef: prepared.sourceManifestRef,
            preparedManifestRef: prepared.preparedManifestRef,
          };
        }
      }
      const synced =
        params.workspace.kind === "repository"
          ? await syncSessionRepositoryWorkspace({
              repository: params.workspace.repository,
              preparedRepository,
              tunnel,
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
              agentId: request.agentId,
              generation: placement.generation,
              gitAuthor,
              runSetupScript: request.runSetupScript,
              assertCurrent: assertSyncOwner,
            })
          : await tunnel.syncWorkspace({
              source: {
                kind: "local",
                path: params.workspace.path,
                ...(project ? { projectKey: project.key } : {}),
              },
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
              generation: placement.generation,
              ...(gitAuthor ? { gitAuthor } : {}),
              authorize: assertSyncOwner,
            });
      assertSyncOwner();
      params.signal?.throwIfAborted();
      params.authorize?.();
      placement = placements.transition({
        sessionId: request.sessionId,
        from: "syncing",
        to: "starting",
        expectedGeneration: placement.generation,
        patch: {
          workspaceBaseManifestRef: synced.manifestRef,
          remoteWorkspaceDir: synced.remoteWorkspaceDir,
        },
      });
      options.reportTransition(params.onTransition, placement);
      const startingPlacement = placement;
      await requireNodePlacementEligibility(
        request,
        requireAttachedEnvironment(),
        admittedNode?.node,
      );
      requireAttachedEnvironment();
      const activate = (): WorkerActiveDispatchPlacement => {
        requireAttachedEnvironment();
        if (
          admittedNode &&
          !options.isCurrentNodePlacement?.(admittedNode.node, admittedNode.requirement)
        ) {
          throw new Error(
            "Worker dispatch lost its current node connection, pairing generation, command authorization, or capacity before activation",
          );
        }
        const active = placements.transition({
          sessionId: request.sessionId,
          from: "starting",
          to: "active",
          expectedGeneration: startingPlacement.generation,
          patch: { activeOwnerEpoch: ownerEpoch },
        });
        if (active.state !== "active") {
          throw new Error("Worker dispatch activation did not produce an active placement");
        }
        // Activation transfers the tunnel to session reconciliation before observers can Stop.
        activated = true;
        params.signal?.removeEventListener("abort", stopAttemptTunnel);
        options.reportTransition(params.onTransition, active);
        return active;
      };
      const activePlacement = await options.runActivationBarrier({
        sessionId: request.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        executionMode: request.executionMode,
        authorize: params.authorize,
        signal: params.signal,
        activate,
      });
      try {
        options.onActivated?.(request);
      } catch {
        // Maintenance scheduling cannot overturn a durable placement activation.
      }
      try {
        environments.schedulePreparedRefill(provisioned.environmentId);
      } catch {
        // Capacity maintenance cannot overturn a durable activation.
      }
      return activePlacement;
    } finally {
      params.signal?.removeEventListener("abort", stopAttemptTunnel);
      if (!activated && params.signal?.aborted) {
        // Start may publish its owner after the first abort. Join that exact epoch as well
        // as the original stop, including initialization, SSH children and scratch cleanup.
        await environments.stopTunnel(provisioned.environmentId, ownerEpoch);
      }
      await stoppingTunnel;
    }
  };

  return {
    bindPreparedPlacement,
    validateDevicePlacement,
    continueProvisionedDispatch,
    retainInterruptedProvisioning,
  };
}
