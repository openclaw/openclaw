import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import { getRuntimeConfig } from "../../config/config.js";
import { DEVICE_FOLDER_MANIFEST_REF } from "../../worker/device-folder.js";
import {
  sameWorkerBuild,
  supportsCurrentWorkerLaunch,
} from "../../worker/worker-build-identity.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  DevicePlacementUnavailableError,
  resolveDevicePlacementEligibility,
  type WorkerNodePlacementAuthority,
} from "./device-placement-eligibility.js";
import { composePlacementAuthorization } from "./placement-authorization.js";
import type {
  WorkerActivationBarrier,
  WorkerActiveDispatchPlacement,
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacement,
  WorkerDispatchPlacementStore,
} from "./placement-dispatch-failure.js";
import { requireProvisionedEnvironment } from "./placement-dispatch-provisioning.js";
import { reportPlacementTransition } from "./placement-record.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import { readWorkerProjectPreparation } from "./preparation-identity.schema.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import { runWorkerProjectLifecycle } from "./project-setup-script.js";
import { syncSessionRepositoryWorkspace } from "./repository-workspace-startup.js";
import type {
  WorkerPlacementAuthorization,
  WorkerPlacementDispatchRequest,
} from "./service-contract.js";
import type { WorkerEnvironmentService } from "./service.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";

export type WorkerDevicePlacementRequirementResolver = (
  identity: Pick<
    WorkerPlacementDispatchRequest,
    "sessionId" | "sessionKey" | "agentId" | "executionMode"
  >,
) => Promise<DevicePlacementRequirement>;

type WorkerNodePlacementAdmission = {
  node: NodeWorkerSupervisorNodeProof;
  requirement: DevicePlacementRequirement;
};

export function createWorkerPlacementDispatchStartup(options: {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService;
  runActivationBarrier: WorkerActivationBarrier;
  onActivated?: (
    request: WorkerPlacementDispatchRequest,
    placement: WorkerActiveDispatchPlacement,
  ) => void;
  resolveGitAuthor?: (agentId: string) => { name?: string; email?: string } | undefined;
  resolveDevicePlacementRequirement?: WorkerDevicePlacementRequirementResolver;
  isCurrentNodePlacement?: WorkerNodePlacementAuthority;
}) {
  const { environments, placements } = options;

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
      executionMode: request.executionMode,
      config: getRuntimeConfig(),
    });
    if (!eligibility.ok) {
      throw new DevicePlacementUnavailableError(deviceId, eligibility.error);
    }
    // Workspace preparation consumes no worker slot. Keep identity and commands live;
    // the node's launch owner admits the eventual turn against physical capacity.
    return {
      node: eligibility.node,
      requirement: { ...requirement, consumesWorkerSlot: false },
    };
  };

  const bindPreparedPlacement = async (params: {
    request: WorkerPlacementDispatchRequest;
    placement: WorkerDispatchPlacement;
    intent: WorkerProviderPreparedIntent;
    assertCurrent: WorkerPlacementAuthorization;
  }) => {
    const preparation =
      params.intent.profileSnapshot.runtimePreparation ??
      params.intent.profileSnapshot.project?.preparation;
    if (!preparation) {
      return undefined;
    }
    const assertCurrent = composePlacementAuthorization(params.assertCurrent, () => {
      environments.assertPreparedIntentCurrent(params.request.profileId, params.intent);
    });
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
        !supportsCurrentWorkerLaunch(environment.bootstrapReceipt) ||
        !sameWorkerBuild(environment.bootstrapReceipt, expectedBuild)
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
      if (
        !admittedNode ||
        !options.isCurrentNodePlacement?.(
          admittedNode.node,
          admittedNode.requirement,
          params.request.executionMode,
        )
      ) {
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
        preparationKey: preparation.key,
        nodeDeviceId: environment.nodeDeviceId,
        leaseId: environment.leaseId,
        bundleHash: expectedBuild.bundleHash,
        assertCurrent: composePlacementAuthorization(assertCurrent, () => {
          if (!options.isCurrentNodePlacement?.(node, requirement, params.request.executionMode)) {
            throw new Error("Prepared worker lost its current node authority before binding");
          }
        }),
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
    environment: Awaited<ReturnType<WorkerEnvironmentService["createWithRequest"]>>;
    expectedEnvironmentId: string;
    workspace: WorkerSessionWorkspace;
    onTransition?: (placement: WorkerDispatchPlacement) => void;
    authorize?: WorkerPlacementAuthorization;
    signal?: AbortSignal;
    admittedNode?: WorkerNodePlacementAdmission;
    markPhase?: (phase: string) => void;
    retainCredentialCleanup?: (revoke: () => Promise<void>) => void;
  }): Promise<WorkerActiveDispatchPlacement> => {
    if (params.placement.state !== "provisioning") {
      throw new Error("Worker dispatch continuation requires a provisioning placement");
    }
    const { request } = params;
    params.markPhase?.("attach");
    if (
      params.workspace.kind === "device-folder" &&
      (params.environment.nodeDeviceId !== params.workspace.deviceId ||
        request.deviceId !== params.workspace.deviceId ||
        request.executionMode !== "worker-turn")
    ) {
      throw new Error("Device folders require an OpenClaw worker on their original paired device");
    }
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
    const credential = await environments.attachSession({
      environmentId: provisioned.environmentId,
      ownerEpoch: provisioned.ownerEpoch,
      sessionId: request.sessionId,
      assertCurrent: assertAttachmentCurrent,
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
    let activated = false;
    let activationIndeterminate = false;
    let stoppingTunnel: Promise<void> | undefined;
    const stopAttemptTunnel = () => {
      stoppingTunnel ??= environments.stopTunnel(provisioned.environmentId, ownerEpoch);
      void stoppingTunnel.catch(() => undefined);
    };
    params.signal?.addEventListener("abort", stopAttemptTunnel, { once: true });
    try {
      params.markPhase?.("tunnel");
      const tunnel = await environments.startTunnel({
        environmentId: provisioned.environmentId,
        ownerEpoch,
        authorize: assertAttachmentCurrent,
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
          attachedEnvironment.nodeDeviceId !== params.environment.nodeDeviceId
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
      let lifecycleHomeDir: string | undefined;
      let assertPreparedBindingCurrent: (() => void) | undefined;
      let preparedRepository: Parameters<
        typeof syncSessionRepositoryWorkspace
      >[0]["preparedRepository"];
      if (preparation) {
        params.markPhase?.("bind");
        const prepared = await environments.bindPreparedWorkspace({
          environmentId: provisioned.environmentId,
          ownerEpoch,
          sessionId: request.sessionId,
          sessionKey: request.sessionKey,
          preparationKey: preparation.key,
          cacheKey: preparation.cacheKey,
          readNativeCredential: request.readNativeCredential,
          retainCredentialCleanup: params.retainCredentialCleanup,
          signal: params.signal,
          assertCurrent: assertSyncOwner,
        });
        assertSyncOwner();
        lifecycleHomeDir = prepared.homeDir;
        assertPreparedBindingCurrent = prepared.assertCurrent;
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
      // Prepared source authority must survive checkpoint loading and every later worker command.
      const assertWorkspaceCurrent = () => {
        assertSyncOwner();
        assertPreparedBindingCurrent?.();
      };
      params.markPhase?.("repositoryStartup");
      const synced =
        params.workspace.kind === "device-folder"
          ? await tunnel.syncWorkspace({
              source: params.workspace,
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
              generation: placement.generation,
              authorize: assertWorkspaceCurrent,
            })
          : params.workspace.kind === "repository"
            ? await syncSessionRepositoryWorkspace({
                markPhase: params.markPhase,
                repository: params.workspace.repository,
                preparedRepository,
                readNativeCredential: request.readNativeCredential,
                retainCredentialCleanup: params.retainCredentialCleanup,
                tunnel,
                sessionId: request.sessionId,
                sessionKey: request.sessionKey,
                agentId: request.agentId,
                generation: placement.generation,
                gitAuthor,
                runSetupScript: request.runSetupScript,
                assertCurrent: assertWorkspaceCurrent,
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
                authorize: assertWorkspaceCurrent,
              });
      if (
        (params.workspace.kind === "device-folder") !==
        (synced.manifestRef === DEVICE_FOLDER_MANIFEST_REF)
      ) {
        throw new Error(
          "Workspace preparation returned a mismatched device-folder manifest marker",
        );
      }
      assertWorkspaceCurrent();
      const runProjectLifecycleCommand = environments.runProjectLifecycleCommand;
      if (preparation?.recipe && preparation.runSetupScript !== false) {
        params.markPhase?.("lifecycleCommands");
        await runWorkerProjectLifecycle({
          recipe: preparation.recipe,
          tunnel,
          workspaceDir: synced.remoteWorkspaceDir,
          homeDir: lifecycleHomeDir,
          runSetupCommand: runProjectLifecycleCommand
            ? (command) =>
                runProjectLifecycleCommand(provisioned.environmentId, ownerEpoch, command)
            : undefined,
          // A completed activation is the existing durable witness. An interrupted
          // first binding retries declared setup; commands should be idempotent.
          postCreate: params.environment.lastActivatedAtMs === null,
          assertCurrent: assertWorkspaceCurrent,
          signal: params.signal,
        });
      }
      params.markPhase?.("activation");
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
        reportPlacementTransition(params.onTransition, active);
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
        options.onActivated?.(request, activePlacement);
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
      params.markPhase?.("cleanup");
      params.signal?.removeEventListener("abort", stopAttemptTunnel);
      if (!activated && !activationIndeterminate && params.signal?.aborted) {
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
  };
}
