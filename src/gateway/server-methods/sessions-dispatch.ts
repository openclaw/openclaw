import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionsDispatchParams,
  validateSessionsDispatchParams,
  validateSessionsMoveParams,
  validateSessionsReclaimParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { resolveDevicePlacementEligibility } from "../worker-environments/device-placement-eligibility.js";
import { selectDevicePlacementCandidates } from "../worker-environments/device-placement-selector.js";
import { DEVICE_WORKER_PROVIDER_ID } from "../worker-environments/device-provider-identity.js";
import { deviceUnavailableText } from "../worker-environments/device-provider.js";
import {
  resolveProjectProfileDestination,
  resolveWorkerPlacementDestination,
} from "../worker-environments/placement-destination.js";
import { canRetryDeviceDispatch } from "../worker-environments/placement-dispatch-failure.js";
import {
  projectWorkerSessionPlacement,
  readWorkerPlacementIdentity,
} from "../worker-environments/placement-projector.js";
import {
  isForceAbandonedWorkerPlacement,
  type WorkerSessionPlacementRecord,
} from "../worker-environments/placement-record.js";
import {
  resolveWorkerPlacementCapabilities,
  resolveWorkerPlacementSessionRuntime,
} from "../worker-environments/placement-session-runtime.js";
import { isFailedWorkerPlacementEnvironmentGone } from "../worker-environments/placement-target.js";
import type { WorkerSessionWorkspace } from "../worker-environments/session-workspace.js";
import { listGatewayEnvironments } from "./environments.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  isWorkerDispatchInputError,
  loadAccessorSessionEntryForGatewayTarget,
  requireSessionKey,
} from "./sessions-shared.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function respondInvalidWorkerSession(respond: RespondFn, message: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

const MAX_AUTO_DEVICE_PLACEMENT_ATTEMPTS = 3;

function resolveWorkerSessionTarget(
  method: "dispatch" | "move" | "reclaim",
  params: SessionsDispatchParams,
  context: GatewayRequestContext,
  respond: RespondFn,
) {
  const key = requireSessionKey(params.key, respond);
  if (!key) {
    return undefined;
  }
  const service = context.workerPlacementDispatchService;
  const reader = context.workerSessionPlacementService;
  if (!service || !reader || (method !== "dispatch" && !service[method])) {
    const operation = {
      dispatch: "cloud worker dispatch",
      move: "session placement move",
      reclaim: "cloud worker stop",
    }[method];
    respondInvalidWorkerSession(respond, `${operation} is not configured`);
    return undefined;
  }
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, params.agentId);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return undefined;
  }
  const destination = resolveWorkerPlacementDestination({
    cfg,
    profileId: params.profileId,
    deviceId: params.deviceId,
    machineClass: params.machineClass,
    os: params.os,
  });
  if (!destination.ok) {
    respondInvalidWorkerSession(respond, destination.error);
    return undefined;
  }
  const target = loadAccessorSessionEntryForGatewayTarget({
    key,
    cfg,
    agentId: requestedAgent.agentId,
  });
  const entry = target.entry;
  const sessionId = normalizeOptionalString(entry?.sessionId);
  if (!entry || !sessionId) {
    respondInvalidWorkerSession(respond, `session not found: ${key}`);
    return undefined;
  }
  return {
    cfg,
    entry,
    session: { sessionId, sessionKey: target.canonicalKey, agentId: target.target.agentId },
    dispatchTarget: destination.value,
    service,
    reader,
  };
}

async function resolveSessionWorkspace(params: {
  entry: NonNullable<ReturnType<typeof loadAccessorSessionEntryForGatewayTarget>["entry"]>;
  sessionKey: string;
  agentId: string;
  method: "sessions.dispatch" | "sessions.move" | "sessions.reclaim";
  respond: RespondFn;
}): Promise<WorkerSessionWorkspace | undefined> {
  if (params.entry.repositoryWorkspaceId) {
    const repository = await getSessionRepositoryWorkspaceStore().get(
      params.entry.repositoryWorkspaceId,
    );
    const current = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
    if (
      current.agentId === params.agentId &&
      current.canonicalKey === params.sessionKey &&
      current.entry?.sessionId === params.entry.sessionId &&
      current.entry?.lifecycleRevision === params.entry.lifecycleRevision &&
      current.entry?.archivedAt === params.entry.archivedAt &&
      current.entry?.repositoryWorkspaceId === params.entry.repositoryWorkspaceId &&
      !current.entry.worktree &&
      repository &&
      repository.agentId === params.agentId &&
      repository.sessionKey === params.sessionKey &&
      !params.entry.worktree
    ) {
      return { kind: "repository", repository };
    }
    respondInvalidWorkerSession(params.respond, "The session repository workspace owner changed.");
    return undefined;
  }
  const worktree = managedWorktrees.findLiveByOwner("session", params.sessionKey);
  if (
    params.entry.worktree?.id &&
    worktree &&
    worktree.id === params.entry.worktree.id &&
    worktree.ownerId === params.sessionKey
  ) {
    return { kind: "local", path: worktree.path };
  }
  const article = params.method === "sessions.dispatch" ? "a" : "the";
  respondInvalidWorkerSession(
    params.respond,
    `${params.method} requires ${article} session-owned worktree or repository workspace`,
  );
  return undefined;
}

function respondWorkerPlacement(params: {
  respond: RespondFn;
  key: string;
  sessionId: string;
  context: GatewayRequestContext;
  placement: Parameters<typeof projectWorkerSessionPlacement>[0];
}): void {
  params.respond(
    true,
    {
      ok: true,
      key: params.key,
      sessionId: params.sessionId,
      placement: projectWorkerSessionPlacement(
        params.placement,
        params.context.workerPlacementDiskSpaceReader?.read(params.placement),
        // Canonical fenced runner reader; a node lost after durable provision
        // must project offline here exactly as sessions.list would.
        params.context.workerPlacementRunnerAvailabilityReader?.read(params.placement),
        readWorkerPlacementIdentity(params.placement, params.context.workerEnvironmentService),
      ),
    },
    undefined,
  );
}

function respondWorkerDispatchError(error: unknown, respond: RespondFn): void {
  if (error instanceof SessionMutationAuthorizationChangedError) {
    throw error;
  }
  respond(
    false,
    undefined,
    errorShape(
      isWorkerDispatchInputError(error) ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
      formatErrorMessage(error),
    ),
  );
}

export const sessionDispatchHandlers: GatewayRequestHandlers = {
  "sessions.dispatch": async ({
    params,
    respond,
    context,
    client,
    signal,
    sessionMutationAuthorization,
  }) => {
    if (
      params.autoDevice === true &&
      (params.profileId !== undefined || params.deviceId !== undefined)
    ) {
      respondInvalidWorkerSession(
        respond,
        "choose exactly one dispatch target: autoDevice, deviceId, or profileId",
      );
      return;
    }
    if (!assertValidParams(params, validateSessionsDispatchParams, "sessions.dispatch", respond)) {
      return;
    }
    const resolved = resolveWorkerSessionTarget("dispatch", params, context, respond);
    if (!resolved) {
      return;
    }
    const { cfg, entry, session, service: dispatchService, reader: placementReader } = resolved;
    const { sessionId, sessionKey, agentId } = session;
    let { dispatchTarget } = resolved;
    const autoDevice = params.autoDevice === true;
    const canUseProjectProfile =
      !autoDevice && params.profileId === undefined && params.deviceId === undefined;
    if (!dispatchTarget && !canUseProjectProfile && !autoDevice) {
      respondInvalidWorkerSession(respond, "worker dispatch target is missing");
      return;
    }
    if (entry.archivedAt !== undefined) {
      respondInvalidWorkerSession(respond, "cannot dispatch an archived session");
      return;
    }
    const sessionRuntime = resolveWorkerPlacementSessionRuntime({
      cfg,
      entry,
      agentId,
      sessionKey,
    });
    const { executionMode, devicePlacement } = resolveWorkerPlacementCapabilities(sessionRuntime);
    if (!executionMode) {
      respondInvalidWorkerSession(
        respond,
        `runtime ${sessionRuntime} lacks cloud placement support`,
      );
      return;
    }
    const validateExecutionMode = async (target: { profileId: string; deviceId?: string }) => {
      if (target.deviceId !== undefined) {
        const eligibility = await resolveDevicePlacementEligibility({
          environmentService: context.workerEnvironmentService,
          deviceId: target.deviceId,
          runtimeId: sessionRuntime,
          executionMode,
          requirement: devicePlacement,
          config: context.getRuntimeConfig(),
          currentNode: context.nodeRegistry?.get?.(target.deviceId),
        });
        if (eligibility.ok) {
          return true;
        }
        respondInvalidWorkerSession(respond, eligibility.error);
        return false;
      }
      const environmentService = context.workerEnvironmentService;
      if (environmentService?.supportsExecutionMode(target.profileId, executionMode)) {
        return true;
      }
      respondInvalidWorkerSession(
        respond,
        `runtime ${sessionRuntime} requires a cloud worker provider that supports ${executionMode}; choose a compatible provider, or select an agent/model route with agentRuntime.id "openclaw"`,
      );
      return false;
    };
    let automaticDeviceIds: string[] = [];
    if (autoDevice) {
      const selection = await selectDevicePlacementCandidates({
        environments: await listGatewayEnvironments(context),
        nodeRegistry: context.nodeRegistry,
        environmentService: context.workerEnvironmentService,
        requirement: devicePlacement,
        runtimeId: sessionRuntime,
        executionMode,
        config: cfg,
        getPendingDispatchCount: (deviceId) =>
          dispatchService.getPendingDeviceDispatchCount?.(deviceId, sessionId) ?? 0,
        getAdmittedSessionCounts: () => dispatchService.getAdmittedDeviceSessionCounts?.(sessionId),
      });
      if (!selection.ok) {
        respondInvalidWorkerSession(respond, selection.error);
        return;
      }
      automaticDeviceIds = selection.candidates
        .slice(0, MAX_AUTO_DEVICE_PLACEMENT_ATTEMPTS)
        .map(({ deviceId }) => deviceId);
      const destination = resolveWorkerPlacementDestination({
        cfg,
        deviceId: automaticDeviceIds[0],
      });
      if (!destination.ok || !destination.value) {
        respondInvalidWorkerSession(
          respond,
          destination.ok ? "automatic device placement did not select a node" : destination.error,
        );
        return;
      }
      dispatchTarget = destination.value;
    }
    if (!autoDevice && dispatchTarget && !(await validateExecutionMode(dispatchTarget))) {
      return;
    }
    const existingPlacement = placementReader.getMany([sessionId]).get(sessionId);
    if (
      existingPlacement?.state === "failed" &&
      !isFailedWorkerPlacementEnvironmentGone({
        environmentService: context.workerEnvironmentService,
        placement: existingPlacement,
      })
    ) {
      let providerId: string | undefined;
      try {
        const identity = readWorkerPlacementIdentity(
          existingPlacement,
          context.workerEnvironmentService,
        );
        providerId = identity?.providerId;
      } catch {
        // Missing inventory proof must retain the refusal even when its label is unknown.
      }
      respondInvalidWorkerSession(
        respond,
        providerId === DEVICE_WORKER_PROVIDER_ID
          ? "device worker placement must be abandoned before redispatch; use Continue on Gateway"
          : "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
      );
      return;
    }
    if (
      existingPlacement &&
      (existingPlacement.state === "active" ||
        existingPlacement.state === "draining" ||
        existingPlacement.state === "reconciling")
    ) {
      respondInvalidWorkerSession(
        respond,
        `session cannot dispatch from placement ${existingPlacement.state}`,
      );
      return;
    }
    const workspace = await resolveSessionWorkspace({
      entry,
      ...session,
      method: "sessions.dispatch",
      respond,
    });
    if (!workspace) {
      return;
    }
    if (!dispatchTarget && canUseProjectProfile) {
      try {
        dispatchTarget = await resolveProjectProfileDestination({ cfg, workspace });
      } catch (error) {
        respondWorkerDispatchError(error, respond);
        return;
      }
    }
    if (!dispatchTarget) {
      respondInvalidWorkerSession(respond, "worker dispatch target is missing");
      return;
    }
    if (canUseProjectProfile && !(await validateExecutionMode(dispatchTarget))) {
      return;
    }
    let lastEligibilityError: string | undefined;
    const candidates = autoDevice ? automaticDeviceIds : [dispatchTarget.deviceId];
    for (let attempt = 0; attempt < candidates.length; attempt += 1) {
      if (attempt > 0) {
        const destination = resolveWorkerPlacementDestination({
          cfg,
          deviceId: candidates[attempt],
        });
        if (!destination.ok || !destination.value) {
          respondInvalidWorkerSession(
            respond,
            destination.ok ? "automatic device placement did not select a node" : destination.error,
          );
          return;
        }
        dispatchTarget = destination.value;
      }
      if (autoDevice) {
        const eligibility = await resolveDevicePlacementEligibility({
          environmentService: context.workerEnvironmentService,
          deviceId: candidates[attempt]!,
          runtimeId: sessionRuntime,
          executionMode,
          requirement: devicePlacement,
          config: cfg,
          currentNode: context.nodeRegistry.get(candidates[attempt]!),
        });
        if (!eligibility.ok) {
          lastEligibilityError = eligibility.error;
          continue;
        }
        // Recheck after asynchronous eligibility, before dispatch registers its pending owner.
        if (
          devicePlacement?.consumesWorkerSlot &&
          eligibility.availableSlots <=
            (dispatchService.getPendingDeviceDispatchCount?.(candidates[attempt]!, sessionId) ?? 0)
        ) {
          lastEligibilityError = deviceUnavailableText(candidates[attempt]!, {
            available: false,
            unavailableReason: "at-capacity",
          });
          continue;
        }
      }
      let attemptedPlacement: WorkerSessionPlacementRecord | undefined;
      try {
        const placement = await dispatchService.dispatch(
          {
            ...session,
            executionMode,
            runSetupScript: client?.connect?.scopes?.includes(ADMIN_SCOPE) === true,
            ...dispatchTarget,
            ...(devicePlacement ? { devicePlacement } : {}),
          },
          (observed) => {
            attemptedPlacement = { ...observed };
            emitSessionsChanged(context, {
              reason: "dispatch",
              sessionKey,
            });
          },
          sessionMutationAuthorization?.assertCurrent,
          signal,
        );
        respondWorkerPlacement({
          respond,
          key: sessionKey,
          sessionId,
          context,
          placement,
        });
        return;
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        if (
          !autoDevice ||
          !dispatchTarget.deviceId ||
          !canRetryDeviceDispatch({
            error,
            deviceId: dispatchTarget.deviceId,
            ...session,
            attempted: attemptedPlacement,
            current: placementReader.getMany([sessionId]).get(sessionId),
            environments: context.workerEnvironmentService,
          })
        ) {
          respondWorkerDispatchError(error, respond);
          return;
        }
        lastEligibilityError = formatErrorMessage(error);
      }
    }
    respondWorkerDispatchError(
      new Error(
        `automatic device placement failed after ${candidates.length} attempts; ${lastEligibilityError ?? "no eligible host remains; reconnect a paired session-host node and retry"}`,
      ),
      respond,
    );
  },
  "sessions.move": async ({ params, respond, context, client, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsMoveParams, "sessions.move", respond)) {
      return;
    }
    const resolved = resolveWorkerSessionTarget("move", params, context, respond);
    if (!resolved) {
      return;
    }
    const { entry, session, service: placementService, reader: placementReader } = resolved;
    const { sessionId, sessionKey } = session;
    if (entry.archivedAt !== undefined) {
      respondInvalidWorkerSession(respond, "cannot move an archived session");
      return;
    }
    const existingPlacement = placementReader.getMany([sessionId]).get(sessionId);
    const retryAbandonment =
      "abandonSource" in params && isForceAbandonedWorkerPlacement(existingPlacement);
    if (
      existingPlacement?.state !== "active" &&
      existingPlacement?.state !== "draining" &&
      !retryAbandonment
    ) {
      respondInvalidWorkerSession(
        respond,
        `session cannot move from placement ${existingPlacement?.state ?? "local"}`,
      );
      return;
    }
    const workspace = await resolveSessionWorkspace({
      entry,
      ...session,
      method: "sessions.move",
      respond,
    });
    if (!workspace) {
      return;
    }
    try {
      const placement = await placementService.move!(
        {
          ...session,
          source: params.expected,
          target: params.target,
          readNativeCredential: factoryGitHubDispatchCredentialReader({
            client,
            sessionId,
            sessionKey: target.canonicalKey,
            agentId: target.target.agentId,
            repositoryUrl: workspace.kind === "repository" ? workspace.repository.url : undefined,
            assertCurrent: () => sessionMutationAuthorization?.assertCurrent(),
          }),
          ...("abandonSource" in params ? { abandonSource: true } : {}),
        },
        () =>
          emitSessionsChanged(context, {
            reason: "move",
            sessionKey,
          }),
        sessionMutationAuthorization?.assertCurrent,
      );
      respond(
        true,
        {
          ok: true,
          key: sessionKey,
          sessionId,
          placement: { state: placement.state, generation: placement.generation },
        },
        undefined,
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      try {
        emitSessionsChanged(context, { reason: "move", sessionKey });
      } catch {
        // Reporting cannot replace the placement owner's failure response.
      }
      respondWorkerDispatchError(error, respond);
    }
  },
  "sessions.reclaim": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateSessionsReclaimParams, "sessions.reclaim", respond)) {
      return;
    }
    const resolved = resolveWorkerSessionTarget("reclaim", params, context, respond);
    if (!resolved) {
      return;
    }
    const { entry, session, service: placementService, reader: placementReader } = resolved;
    const { sessionId, sessionKey } = session;
    const existingPlacement = placementReader.getMany([sessionId]).get(sessionId);
    const reportPlacementChange = (placement: WorkerSessionPlacementRecord | undefined): void => {
      if (
        !placement ||
        (existingPlacement &&
          placement.state === existingPlacement.state &&
          placement.generation === existingPlacement.generation &&
          placement.updatedAtMs === existingPlacement.updatedAtMs)
      ) {
        return;
      }
      try {
        emitSessionsChanged(context, { reason: "reclaim", sessionKey });
      } catch {
        // Reporting cannot replace a committed reclaim outcome.
      }
    };
    const workspace =
      existingPlacement?.state !== "failed" || params.recoverToGateway
        ? await resolveSessionWorkspace({
            entry,
            ...session,
            method: "sessions.reclaim",
            respond,
          })
        : undefined;
    if ((existingPlacement?.state !== "failed" || params.recoverToGateway) && !workspace) {
      return;
    }
    let placement: WorkerSessionPlacementRecord;
    try {
      placement = await placementService.reclaim!(
        {
          ...session,
          ...(params.recoverToGateway ? { recoverToGateway: params.recoverToGateway } : {}),
          readNativeCredential: factoryGitHubDispatchCredentialReader({
            client,
            sessionId,
            sessionKey: target.canonicalKey,
            agentId: target.target.agentId,
            repositoryUrl: workspace?.kind === "repository" ? workspace.repository.url : undefined,
            assertCurrent: () => sessionMutationAuthorization?.assertCurrent(),
          }),
        },
        sessionMutationAuthorization?.assertCurrent,
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      reportPlacementChange(placementReader.getMany([sessionId]).get(sessionId));
      respondWorkerDispatchError(error, respond);
      return;
    }
    reportPlacementChange(placement);
    respondWorkerPlacement({ respond, key: sessionKey, sessionId, context, placement });
  },
};
