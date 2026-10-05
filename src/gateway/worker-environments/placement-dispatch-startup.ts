import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  DevicePlacementUnavailableError,
  resolveDevicePlacementEligibility,
  type WorkerNodePlacementAuthority,
} from "./device-placement-eligibility.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import { recordWorkerPlacementAwait, recordWorkerPlacementStage } from "./placement-diagnostics.js";
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
import { prepareActiveRepository } from "./placement-repository-preparation.js";
import { syncProvisionedWorkspace } from "./placement-workspace-startup.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
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
    asynchronousRepository?: boolean;
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
    let activated = false;
    // Provisioning and transport setup yield; revoked callers must not attach or upload.
    params.signal?.throwIfAborted();
    params.authorize?.();
    const assertRequestCurrent = () => {
      (activated ? request.repositoryPreparationSignal : params.signal)?.throwIfAborted();
      if (activated) {
        request.operatorAuthority?.assertCurrent();
        request.assertRepositoryPreparationCurrent?.();
      } else {
        params.authorize?.();
      }
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
      assertRequestCurrent();
      const current = placements.get(request.sessionId);
      if (
        !current ||
        (activated ? current?.state !== "active" : current?.state !== "syncing") ||
        current.generation !== (activated ? placement.generation : syncingPlacement.generation) ||
        current.sessionKey !== request.sessionKey ||
        current.agentId !== request.agentId ||
        current.executionMode !== request.executionMode ||
        current.environmentId !== provisioned.environmentId ||
        (!activated && current.turnClaim !== null)
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
    let activationIndeterminate = false;
    let stoppingTunnel: Promise<void> | undefined;
    let releaseRepositoryAuthority: (() => void) | undefined;
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
        signal: params.signal,
      });
      params.signal?.throwIfAborted();
      params.authorize?.();
      recordWorkerPlacementStage(request.sessionId, "tunnel_ready", {
        environmentId: provisioned.environmentId,
        ownerEpoch,
      });
      const gitAuthor = options.resolveGitAuthor?.(request.agentId);
      const requireAttachedEnvironment = () => {
        (activated ? request.repositoryPreparationSignal : params.signal)?.throwIfAborted();
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
      const syncFacts = {
        generation: placement.generation,
        environmentId: provisioned.environmentId,
        ownerEpoch,
      };
      const asynchronousRepository = Boolean(
        params.asynchronousRepository &&
        params.workspace.kind === "repository" &&
        tunnel.prepareRepositoryWorkspace &&
        tunnel.settleRepositoryWorkspace,
      );
      if (asynchronousRepository && admittedNode?.node.workerHost.repositoryReadiness !== 1) {
        throw new Error("Update the worker host before asynchronous repository preparation");
      }
      releaseRepositoryAuthority = asynchronousRepository
        ? request.operatorAuthority!.retain!()
        : undefined;
      const pendingDirectory =
        asynchronousRepository && params.workspace.kind === "repository"
          ? await tunnel.prepareRepositoryWorkspace!({
              sessionKey: request.sessionKey,
              repository: params.workspace.repository,
              assertCurrent: assertSyncOwner,
              signal: params.signal,
            })
          : undefined;
      const performSync = (
        repository?: import("../../state/session-repository-workspaces.types.js").SessionRepositoryWorkspaceRecord,
      ) =>
        syncProvisionedWorkspace({
          request,
          environments,
          environment: params.environment,
          workspace: params.workspace,
          tunnel,
          generation: placement.generation,
          ownerEpoch,
          repository,
          gitAuthor,
          signal: activated ? request.repositoryPreparationSignal : params.signal,
          recovery: params.recovery,
          asynchronousRepository,
          assertCurrent: assertSyncOwner,
        });
      const synced = asynchronousRepository ? undefined : await performSync();
      if (params.intent && !asynchronousRepository) {
        const intent = params.intent;
        await recordWorkerPlacementAwait(
          request.sessionId,
          "post_sync_repository_revalidation",
          async () => {
            await environments.revalidatePreparedIntentRepository(
              request.profileId,
              intent,
              params.signal,
            );
            assertSyncOwner();
          },
          syncFacts,
          "dispatch",
        );
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
            workspaceBaseManifestRef: synced?.manifestRef ?? null,
            remoteWorkspaceDir: synced?.remoteWorkspaceDir ?? pendingDirectory!,
            ...(asynchronousRepository ? { repositoryPreparation: "pending" as const } : {}),
          },
        },
        assertActivationCurrent,
      );
      reportPlacementTransition(params.onTransition, placement);
      const startingPlacement = placement;
      const activationFacts = {
        generation: placement.generation,
        environmentId: provisioned.environmentId,
        ownerEpoch,
      };
      const activePlacement = await recordWorkerPlacementAwait(
        request.sessionId,
        "activation",
        async () => {
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
          return params.recovery
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
        },
        activationFacts,
        "placement",
      );
      placement = activePlacement;
      if (asynchronousRepository && params.workspace.kind === "repository") {
        const assertCleanupCurrent = () => {
          request.assertRepositoryCleanupCurrent?.();
          const current = placements.get(request.sessionId);
          const environment = environments.get(provisioned.environmentId);
          if (
            current?.state !== "active" ||
            current.generation !== activePlacement.generation ||
            current.sessionKey !== request.sessionKey ||
            current.agentId !== request.agentId ||
            current.environmentId !== provisioned.environmentId ||
            current.activeOwnerEpoch !== ownerEpoch ||
            environment?.state !== "attached" ||
            environment.ownerEpoch !== ownerEpoch ||
            environment.leaseId !== params.environment.leaseId ||
            environment.attachedSessionIds.length !== 1 ||
            environment.attachedSessionIds[0] !== request.sessionId
          ) {
            throw new Error("Repository cleanup owner changed");
          }
        };
        const preparation = prepareActiveRepository({
          request,
          placement: activePlacement,
          repository: params.workspace.repository,
          environments,
          placements,
          tunnel,
          assertCurrent: assertSyncOwner,
          assertCleanupCurrent,
          sync: performSync,
          releaseAuthority: releaseRepositoryAuthority!,
          onTransition: params.onTransition,
        });
        releaseRepositoryAuthority = undefined;
        request.trackRepositoryPreparation!(preparation);
      }
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
      releaseRepositoryAuthority?.();
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
