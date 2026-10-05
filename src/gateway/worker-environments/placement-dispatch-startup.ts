import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  DevicePlacementUnavailableError,
  resolveDevicePlacementEligibility,
  type WorkerNodePlacementAuthority,
} from "./device-placement-eligibility.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import { readImageReserveProject } from "./image-reserve.js";
import { recordWorkerPlacementStage } from "./placement-diagnostics.js";
import type {
  PlacementFailureActions,
  WorkerActivationBarrier,
  WorkerActiveDispatchPlacement,
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacement,
  WorkerDispatchPlacementStore,
  WorkerProvisioningDispatchPlacement,
} from "./placement-dispatch-failure.js";
import {
  createWorkerPreparedPlacementBinder,
  type WorkerNodePlacementAdmission,
} from "./placement-dispatch-prepared.js";
import {
  createInterruptedWorkerProvisioningRetainer,
  isPendingProvisioningEnvironment,
  requireProvisionedEnvironment,
} from "./placement-dispatch-provisioning.js";
import { reportPlacementTransition } from "./placement-record.js";
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
import type { WorkerEnvironmentReconcileCore } from "./service.types.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";

export type WorkerPlacementRecoveryBarrier = (params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementDispatchRequest["executionMode"];
  environmentId: string;
  expectedGeneration: number;
  signal?: AbortSignal;
  run: (workspace: WorkerSessionWorkspace, assertCurrent?: () => void) => Promise<void>;
}) => Promise<void>;

export type WorkerDevicePlacementRequirementResolver = (
  identity: Pick<
    WorkerPlacementDispatchRequest,
    "sessionId" | "sessionKey" | "agentId" | "executionMode"
  >,
) => Promise<DevicePlacementRequirement>;

export function createWorkerPlacementDispatchStartup(options: {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService & Pick<WorkerEnvironmentService, "recordError">;
  isShuttingDown?: () => boolean;
  failure: PlacementFailureActions;
  runRecoveryBarrier: WorkerPlacementRecoveryBarrier;
  runActivationBarrier: WorkerActivationBarrier;
  onActivated?: (request: WorkerPlacementDispatchRequest) => void;
  resolveGitAuthor?: (agentId: string) => { name?: string; email?: string } | undefined;
  resolveDevicePlacementRequirement?: WorkerDevicePlacementRequirementResolver;
  isCurrentNodePlacement?: WorkerNodePlacementAuthority;
}) {
  const { environments, failure, placements } = options;

  const retainInterruptedProvisioning = createInterruptedWorkerProvisioningRetainer(options);

  const validateDevicePlacement = async (request: WorkerPlacementDispatchRequest) => {
    if (!request.deviceId) {
      return;
    }
    const eligibility = await resolveDevicePlacementEligibility({
      environmentService: environments,
      deviceId: request.deviceId,
      requirement: request.devicePlacement,
      executionMode: request.executionMode,
      config: getRuntimeConfig(),
    });
    if (!eligibility.ok) {
      throw new DevicePlacementUnavailableError(request.deviceId, eligibility.error);
    }
  };
  const requireNodePlacementEligibility = async (
    request: WorkerPlacementDispatchRequest,
    environment: Awaited<ReturnType<WorkerEnvironmentService["createWithRequest"]>>,
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
      requirement: admittedNode ? { ...requirement, consumesWorkerSlot: false } : requirement,
      executionMode: request.executionMode,
      config: getRuntimeConfig(),
      ...(admittedNode ? { currentNode: admittedNode } : {}),
    });
    if (!eligibility.ok) {
      throw admittedNode
        ? new Error(eligibility.error)
        : new DevicePlacementUnavailableError(deviceId, eligibility.error);
    }
    // Workspace preparation consumes no worker slot. Keep identity and commands live;
    // the node's launch owner admits the eventual turn against physical capacity.
    return {
      node: eligibility.node,
      requirement: { ...requirement, consumesWorkerSlot: false },
    };
  };

  const bindPreparedPlacement = createWorkerPreparedPlacementBinder({
    ...options,
    requireNodePlacementEligibility,
  });
  const continueProvisionedDispatch = async (params: {
    request: WorkerPlacementDispatchRequest;
    placement: WorkerDispatchPlacement;
    environment: Awaited<ReturnType<WorkerEnvironmentService["createWithRequest"]>>;
    expectedEnvironmentId: string;
    workspace: WorkerSessionWorkspace;
    intent?: WorkerProviderPreparedIntent;
    onTransition?: (placement: WorkerDispatchPlacement) => void;
    authorize?: WorkerPlacementAuthorization;
    signal?: AbortSignal;
    recovery?: true;
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
    const assertRequestCurrent = () => {
      params.signal?.throwIfAborted();
      params.authorize?.();
    };
    let placement = await placements.transition(
      {
        sessionId: request.sessionId,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: params.placement.generation,
        patch: {
          environmentId: provisioned.environmentId,
          workerBundleHash: provisioned.bundleHash,
        },
      },
      assertRequestCurrent,
    );
    reportPlacementTransition(params.onTransition, placement);
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
        !options.isCurrentNodePlacement?.(
          admittedNode.node,
          admittedNode.requirement,
          request.executionMode,
        )
      ) {
        throw new Error("Worker dispatch lost its current node authority before attachment");
      }
    };
    assertAttachmentCurrent();
    recordWorkerPlacementStage(request.sessionId, "session_attach_started", {
      generation: placement.generation,
      environmentId: provisioned.environmentId,
      ownerEpoch: provisioned.ownerEpoch,
    });
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
    });
    params.signal?.throwIfAborted();
    params.authorize?.();
    const ownerEpoch = credential.ownerEpoch;
    recordWorkerPlacementStage(request.sessionId, "session_attached", {
      generation: placement.generation,
      environmentId: provisioned.environmentId,
      ownerEpoch,
    });
    let activated = false;
    let activationIndeterminate = false;
    let stoppingTunnel: Promise<void> | undefined;
    const stopAttemptTunnel = () => {
      stoppingTunnel ??= environments.stopTunnel(provisioned.environmentId, ownerEpoch);
      void stoppingTunnel.catch(() => undefined);
    };
    params.signal?.addEventListener("abort", stopAttemptTunnel, { once: true });
    try {
      recordWorkerPlacementStage(request.sessionId, "tunnel_started", {
        environmentId: provisioned.environmentId,
        ownerEpoch,
      });
      const tunnel = await environments.startTunnel({
        environmentId: provisioned.environmentId,
        ownerEpoch,
        authorize: assertAttachmentCurrent,
      });
      params.signal?.throwIfAborted();
      params.authorize?.();
      recordWorkerPlacementStage(request.sessionId, "tunnel_ready", {
        environmentId: provisioned.environmentId,
        ownerEpoch,
      });
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
      recordWorkerPlacementStage(request.sessionId, "workspace_sync_started", {
        environmentId: provisioned.environmentId,
        ownerEpoch,
      });
      const preparation = readWorkerProjectPreparation(params.environment.profileSnapshot.project);
      let preparedRepository: Parameters<
        typeof syncSessionRepositoryWorkspace
      >[0]["preparedRepository"];
      if (preparation && !readImageReserveProject(params.environment.profileSnapshot.project)) {
        if (project && "source" in project) {
          if (
            params.workspace.kind !== "repository" ||
            project.source.url !== params.workspace.repository.url
          ) {
            throw new Error("Prepared repository does not match this session's source");
          }
        }
        // Every command to a prepared workspace needs its session binding.
        // Reuse the checkout only when its immutable base matches or is unpinned.
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
        if (project && "source" in project && params.workspace.kind === "repository") {
          if (
            !params.workspace.repository.baseCommit ||
            project.baseCommit === params.workspace.repository.baseCommit
          ) {
            preparedRepository = {
              baseCommit: project.baseCommit,
              workspaceDir: prepared.workspaceDir,
              sourceManifestRef: prepared.sourceManifestRef,
              preparedManifestRef: prepared.preparedManifestRef,
            };
          }
        }
      }
      const retainedSource = environments.readRecoveryHold?.(request.sessionId);
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
              recovery: params.recovery,
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
      recordWorkerPlacementStage(request.sessionId, "workspace_sync_completed", {
        environmentId: provisioned.environmentId,
        ownerEpoch,
      });
      if (params.intent) {
        await environments.revalidatePreparedIntentRepository(
          request.profileId,
          params.intent,
          params.signal,
        );
        assertSyncOwner();
      }
      params.signal?.throwIfAborted();
      params.authorize?.();
      const assertActivationCurrent = () => {
        assertRequestCurrent();
        requireAttachedEnvironment();
        if (
          admittedNode &&
          !options.isCurrentNodePlacement?.(
            admittedNode.node,
            admittedNode.requirement,
            request.executionMode,
          )
        ) {
          throw new Error(
            "Worker dispatch lost its current node connection, pairing generation, or command authorization before activation",
          );
        }
      };
      placement = await placements.transition(
        {
          sessionId: request.sessionId,
          from: "syncing",
          to: "starting",
          expectedGeneration: placement.generation,
          patch: {
            workspaceBaseManifestRef: synced.manifestRef,
            remoteWorkspaceDir: synced.remoteWorkspaceDir,
          },
        },
        assertActivationCurrent,
      );
      reportPlacementTransition(params.onTransition, placement);
      const startingPlacement = placement;
      recordWorkerPlacementStage(request.sessionId, "activation_started", {
        generation: placement.generation,
        environmentId: provisioned.environmentId,
        ownerEpoch,
      });
      await requireNodePlacementEligibility(
        request,
        requireAttachedEnvironment(),
        admittedNode?.node,
      );
      requireAttachedEnvironment();
      const activate = async (
        assertLifecycleCurrent?: () => void,
      ): Promise<WorkerActiveDispatchPlacement> => {
        const active = await placements.transition(
          {
            sessionId: request.sessionId,
            from: "starting",
            to: "active",
            expectedGeneration: startingPlacement.generation,
            patch: { activeOwnerEpoch: ownerEpoch },
          },
          () => {
            assertActivationCurrent();
            assertLifecycleCurrent?.();
          },
        );
        if (active.state !== "active") {
          throw new Error("Worker dispatch activation did not produce an active placement");
        }
        // Activation transfers the tunnel to session reconciliation before observers can Stop.
        activated = true;
        params.signal?.removeEventListener("abort", stopAttemptTunnel);
        recordWorkerPlacementStage(request.sessionId, "active", {
          generation: active.generation,
          environmentId: provisioned.environmentId,
          ownerEpoch,
        });
        reportPlacementTransition(params.onTransition, active);
        return active;
      };
      // Recovery retains the exact session/placement lifecycle fence through activation.
      const activePlacement = params.recovery
        ? await activate()
        : await options.runActivationBarrier({
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
    } catch (error) {
      activationIndeterminate = error instanceof AcceptedWorkspacePublicationIndeterminateError;
      throw error;
    } finally {
      params.signal?.removeEventListener("abort", stopAttemptTunnel);
      if (!activated && !activationIndeterminate && params.signal?.aborted) {
        // Start may publish its owner after the first abort. Join that exact epoch as well
        // as the original stop, including initialization, SSH children and scratch cleanup.
        await environments.stopTunnel(provisioned.environmentId, ownerEpoch);
      }
      await stoppingTunnel;
    }
  };

  const resumeProvisioning = async (
    placement: WorkerProvisioningDispatchPlacement,
    reconcileEnvironmentCore: WorkerEnvironmentReconcileCore,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
    runAdmitted: (
      run: (signal?: AbortSignal) => Promise<WorkerDispatchPlacement | undefined>,
    ) => Promise<WorkerDispatchPlacement | undefined> = (run) => run(),
  ): Promise<WorkerDispatchPlacement | undefined> => {
    const environmentId = placement.environmentId;
    let recoveryRunStarted = false;
    let interruptedByShutdown = false;
    let result: WorkerDispatchPlacement | undefined;
    let recoveryOwnedPlacement: WorkerDispatchPlacement = placement;
    const report = (next: WorkerDispatchPlacement) => {
      recoveryOwnedPlacement = next;
      reportPlacementTransition(onTransition, next);
    };
    report(placement);
    const handleRecoveryFailure = async (
      error: unknown,
    ): Promise<WorkerDispatchPlacement | undefined> => {
      if (error instanceof AcceptedWorkspacePublicationIndeterminateError) {
        throw error;
      }
      const retained = await retainInterruptedProvisioning(recoveryOwnedPlacement, error);
      if (retained) {
        report(retained);
        interruptedByShutdown = true;
        throw error;
      }
      const current = placements.get(placement.sessionId);
      if (
        !current ||
        (current.state !== "provisioning" &&
          current.state !== "syncing" &&
          current.state !== "starting") ||
        current.state !== recoveryOwnedPlacement.state ||
        current.generation !== recoveryOwnedPlacement.generation ||
        current.environmentId !== environmentId ||
        current.sessionKey !== placement.sessionKey ||
        current.agentId !== placement.agentId ||
        current.executionMode !== placement.executionMode
      ) {
        return undefined;
      }
      const environment = environmentId ? environments.get(environmentId) : undefined;
      // Only a provider replay entered with exact authority may retain its durable operation.
      if (
        recoveryRunStarted &&
        current.state === "provisioning" &&
        isPendingProvisioningEnvironment(environment, environmentId)
      ) {
        return undefined;
      }
      const exactEnvironment = environment?.environmentId === environmentId ? environment : null;
      const failed = await failure.teardownEnvironment({
        placement: current,
        environmentId: exactEnvironment?.environmentId ?? null,
        ownerEpoch: exactEnvironment?.ownerEpoch ?? null,
        primaryError: error,
      });
      report(failed);
      return failed;
    };
    const recover = async (signal?: AbortSignal) => {
      try {
        if (!environmentId) {
          throw new Error("Provisioning worker placement has no environment owner");
        }
        await options.runRecoveryBarrier({
          sessionId: placement.sessionId,
          sessionKey: placement.sessionKey,
          agentId: placement.agentId,
          executionMode: placement.executionMode,
          environmentId,
          expectedGeneration: placement.generation,
          signal,
          run: async (workspace, assertCurrent) => {
            recoveryRunStarted = true;
            try {
              signal?.throwIfAborted();
              const initialEnvironment = environments.get(environmentId);
              if (initialEnvironment?.environmentId !== environmentId) {
                throw new Error("Provisioning worker environment record is missing");
              }
              if (initialEnvironment.destroyRequestedAtMs !== null) {
                throw new Error("Provisioning worker environment destruction was requested");
              }
              await reconcileEnvironmentCore(signal);
              signal?.throwIfAborted();
              const current = placements.get(placement.sessionId);
              if (
                current?.state !== "provisioning" ||
                current.generation !== placement.generation ||
                current.environmentId !== environmentId
              ) {
                throw new Error("Provisioning worker placement changed during restart recovery");
              }
              const environment = environments.get(environmentId);
              if (environment?.environmentId !== environmentId) {
                throw new Error("Provisioning worker environment record is missing");
              }
              if (isPendingProvisioningEnvironment(environment, environmentId)) {
                return;
              }
              let devicePlacement: DevicePlacementRequirement | undefined;
              if (environment.nodeDeviceId) {
                if (!options.resolveDevicePlacementRequirement) {
                  throw new Error("Node-backed recovery has no authoritative runtime requirement");
                }
                devicePlacement = await options.resolveDevicePlacementRequirement({
                  sessionId: placement.sessionId,
                  sessionKey: placement.sessionKey,
                  agentId: placement.agentId,
                  executionMode: placement.executionMode,
                });
              }
              result = await continueProvisionedDispatch({
                request: {
                  sessionId: placement.sessionId,
                  sessionKey: placement.sessionKey,
                  agentId: placement.agentId,
                  profileId: environment.profileId,
                  executionMode: placement.executionMode,
                  ...(devicePlacement ? { devicePlacement } : {}),
                  ...(environment.providerId === DEVICE_WORKER_PROVIDER_ID &&
                  environment.nodeDeviceId
                    ? { deviceId: environment.nodeDeviceId }
                    : {}),
                },
                placement: current,
                environment,
                expectedEnvironmentId: environmentId,
                workspace,
                onTransition: report,
                signal,
                authorize: assertCurrent,
                recovery: true,
              });
            } catch (error) {
              // Keep teardown under the same session lifecycle fence that admitted recovery.
              result = await handleRecoveryFailure(error);
            }
          },
        });
      } catch (error) {
        if (interruptedByShutdown) {
          throw error;
        }
        result = await handleRecoveryFailure(error);
      }
      return result;
    };
    try {
      return await runAdmitted(recover);
    } catch (error) {
      // A refused session owner still owes cleanup. Shutdown and queued cancellation
      // remain with their existing owners and must not destroy an adoptable allocation.
      if (interruptedByShutdown || !(error instanceof WorkerPlacementAdmissionTargetError)) {
        throw error;
      }
      return await handleRecoveryFailure(error);
    }
  };

  return {
    bindPreparedPlacement,
    validateDevicePlacement,
    continueProvisionedDispatch,
    retainInterruptedProvisioning,
    resumeProvisioning,
  };
}
