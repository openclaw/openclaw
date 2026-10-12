import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionsDispatchParams,
  validateSessionsDispatchParams,
  validateSessionsMoveParams,
  validateSessionsReclaimParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { assertRequiredWorkerSelection } from "../../config/required-worker-profile.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  loadWorkerPlacementSessionRuntimeModule,
  resolveWorkerPlacementSessionTarget,
} from "../server-worker-placement-session-target.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { withGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import { resolveDevicePlacementEligibility } from "../worker-environments/device-placement-eligibility.js";
import { selectDevicePlacementCandidates } from "../worker-environments/device-placement-selector.js";
import { DEVICE_WORKER_PROVIDER_ID } from "../worker-environments/device-provider-identity.js";
import { deviceUnavailableText } from "../worker-environments/device-provider.js";
import type { WorkerPlacementAuthorization } from "../worker-environments/placement-authorization.js";
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
  resolveWorkerPlacementSessionRuntimeAsync,
} from "../worker-environments/placement-session-runtime.js";
import { isFailedWorkerPlacementEnvironmentGone } from "../worker-environments/placement-target.js";
import type { WorkerPlacementDispatchRequest } from "../worker-environments/service-contract.js";
import { readSessionWorkerPlacementAsync } from "../worker-environments/session-placement-lifecycle.js";
import type { WorkerSessionWorkspace } from "../worker-environments/session-workspace.js";
import { listGatewayEnvironments } from "./environments.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { isWorkerDispatchInputError, requireSessionKey } from "./sessions-shared.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
  SessionMutationAuthorization,
} from "./types.js";
import { assertValidParams } from "./validation.js";

function respondInvalidWorkerSession(respond: RespondFn, message: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

const MAX_AUTO_DEVICE_PLACEMENT_ATTEMPTS = 3;

async function withWorkerPlacementAuthorization<T>(
  authorization: SessionMutationAuthorization | undefined,
  operation: (authorize: WorkerPlacementAuthorization | undefined) => Promise<T>,
): Promise<T> {
  const assertCurrent = authorization?.assertCurrent;
  const prepared = await authorization?.prepareWorkerGrant?.();
  try {
    return await operation(
      prepared
        ? Object.assign(() => prepared.assertCurrent(), {
            assertWorkerGrant: prepared.assertCurrent,
            assertWorkerLifetime: prepared.assertLifetimeCurrent,
          })
        : assertCurrent,
    );
  } finally {
    await prepared?.release();
  }
}

async function withWorkerSessionTarget(
  method: "dispatch" | "move" | "reclaim",
  params: SessionsDispatchParams,
  context: GatewayRequestContext,
  respond: RespondFn,
  consume: (resolved: {
    cfg: OpenClawConfig;
    entry: SessionEntry;
    session: { sessionId: string; sessionKey: string; agentId: string };
    dispatchTarget:
      | Extract<ReturnType<typeof resolveWorkerPlacementDestination>, { ok: true }>["value"]
      | undefined;
    service: NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>;
    reader: NonNullable<GatewayRequestContext["workerSessionPlacementService"]>;
  }) => Promise<void>,
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
  const destination =
    method === "dispatch"
      ? resolveWorkerPlacementDestination({
          cfg,
          profileId: params.profileId,
          deviceId: params.deviceId,
          machineClass: params.machineClass,
          os: params.os,
        })
      : { ok: true as const, value: undefined };
  if (!destination.ok) {
    respondInvalidWorkerSession(respond, destination.error);
    return undefined;
  }
  return withGatewaySessionEntryReadOnly(
    { key, cfg, agentId: requestedAgent.agentId, excludeInternalEffects: true },
    async (target) => {
      const entry = target.entry;
      const sessionId = normalizeOptionalString(entry?.sessionId);
      if (!entry || !sessionId) {
        respondInvalidWorkerSession(respond, `session not found: ${key}`);
        return;
      }
      await consume({
        cfg,
        entry,
        session: { sessionId, sessionKey: target.canonicalKey, agentId: target.agentId },
        dispatchTarget: destination.value,
        service,
        reader,
      });
    },
  );
}

async function resolveSessionWorkspace(params: {
  config: OpenClawConfig;
  entry: SessionEntry;
  sessionKey: string;
  agentId: string;
  method: "sessions.dispatch" | "sessions.move" | "sessions.reclaim";
  respond: RespondFn;
  assertCurrent?: () => void;
}): Promise<WorkerSessionWorkspace | undefined> {
  const article = params.method === "sessions.dispatch" ? "a" : "the";
  try {
    const resolved = await resolveWorkerPlacementSessionTarget({
      sessionRuntime: await loadWorkerPlacementSessionRuntimeModule(),
      config: params.config,
      sessionId: params.entry.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      expectedEntry: params.entry,
      errorMessage: `${params.method} requires ${article} session-owned worktree or repository workspace`,
    });
    params.assertCurrent?.();
    return resolved.workspace;
  } catch (error) {
    if (error instanceof SessionMutationAuthorizationChangedError) {
      throw error;
    }
    respondInvalidWorkerSession(params.respond, formatErrorMessage(error));
    return undefined;
  }
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
    try {
      assertRequiredWorkerSelection(context.getRuntimeConfig(), params);
    } catch (error) {
      respondWorkerDispatchError(error, respond);
      return;
    }
    return withWorkerSessionTarget("dispatch", params, context, respond, async (resolved) => {
      const { cfg, entry, session, service: dispatchService } = resolved;
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
      const sessionRuntime = await resolveWorkerPlacementSessionRuntimeAsync({
        cfg,
        entry,
        agentId,
        sessionKey,
        assertCurrent: sessionMutationAuthorization?.assertCurrent,
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
          getAdmittedSessionCounts: () =>
            dispatchService.getAdmittedDeviceSessionCountsAsync
              ? dispatchService.getAdmittedDeviceSessionCountsAsync(sessionId)
              : dispatchService.getAdmittedDeviceSessionCounts?.(sessionId),
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
      const existingPlacement = await readSessionWorkerPlacementAsync({ context, sessionId });
      sessionMutationAuthorization?.assertCurrent();
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
        config: context.getRuntimeConfig(),
        entry,
        ...session,
        method: "sessions.dispatch",
        respond,
        assertCurrent: sessionMutationAuthorization?.assertCurrent,
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
      const initialDispatchTarget = dispatchTarget;
      try {
        const result = await withWorkerPlacementAuthorization<
          { placement: WorkerSessionPlacementRecord } | { invalid: string }
        >(sessionMutationAuthorization, async (authorize) => {
          let candidateTarget = initialDispatchTarget;
          let lastEligibilityError: string | undefined;
          const candidates = autoDevice ? automaticDeviceIds : [candidateTarget.deviceId];
          for (let attempt = 0; attempt < candidates.length; attempt += 1) {
            if (attempt > 0) {
              const destination = resolveWorkerPlacementDestination({
                cfg,
                deviceId: candidates[attempt],
              });
              if (!destination.ok || !destination.value) {
                return {
                  invalid: destination.ok
                    ? "automatic device placement did not select a node"
                    : destination.error,
                };
              }
              candidateTarget = destination.value;
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
              // Keep the final capacity check and pending-owner registration in one synchronous turn.
              if (
                devicePlacement?.consumesWorkerSlot &&
                eligibility.availableSlots <=
                  (dispatchService.getPendingDeviceDispatchCount?.(
                    candidates[attempt]!,
                    sessionId,
                  ) ?? 0)
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
              const request: WorkerPlacementDispatchRequest = {
                ...session,
                executionMode,
                runSetupScript: client?.connect?.scopes?.includes(ADMIN_SCOPE) === true,
                ...candidateTarget,
                ...(devicePlacement ? { devicePlacement } : {}),
              };
              const placement = await dispatchService.dispatch(
                request,
                (observed) => {
                  attemptedPlacement = { ...observed };
                  emitSessionsChanged(context, {
                    reason: "dispatch",
                    sessionKey,
                  });
                },
                authorize,
                signal,
              );
              return { placement };
            } catch (error) {
              if (error instanceof SessionMutationAuthorizationChangedError) {
                throw error;
              }
              if (
                !autoDevice ||
                !candidateTarget.deviceId ||
                !canRetryDeviceDispatch({
                  error,
                  deviceId: candidateTarget.deviceId,
                  ...session,
                  attempted: attemptedPlacement,
                  current: await readSessionWorkerPlacementAsync({ context, sessionId }),
                  environments: context.workerEnvironmentService,
                })
              ) {
                throw error;
              }
              lastEligibilityError = formatErrorMessage(error);
            }
          }
          throw new Error(
            `automatic device placement failed after ${candidates.length} attempts; ${lastEligibilityError ?? "no eligible host remains; reconnect a paired session-host node and retry"}`,
          );
        });
        if ("invalid" in result) {
          respondInvalidWorkerSession(respond, result.invalid);
        } else {
          respondWorkerPlacement({
            respond,
            key: sessionKey,
            sessionId,
            context,
            placement: result.placement,
          });
        }
      } catch (error) {
        respondWorkerDispatchError(error, respond);
      }
    });
  },
  "sessions.move": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsMoveParams, "sessions.move", respond)) {
      return;
    }
    return withWorkerSessionTarget("move", params, context, respond, async (resolved) => {
      const { entry, session, service: placementService } = resolved;
      const { sessionId, sessionKey } = session;
      if (entry.archivedAt !== undefined) {
        respondInvalidWorkerSession(respond, "cannot move an archived session");
        return;
      }
      const existingPlacement = await readSessionWorkerPlacementAsync({ context, sessionId });
      sessionMutationAuthorization?.assertCurrent();
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
      if (
        !(await resolveSessionWorkspace({
          config: context.getRuntimeConfig(),
          entry,
          ...session,
          method: "sessions.move",
          respond,
          assertCurrent: sessionMutationAuthorization?.assertCurrent,
        }))
      ) {
        return;
      }
      try {
        const placement = await withWorkerPlacementAuthorization(
          sessionMutationAuthorization,
          (authorize) =>
            placementService.move!(
              {
                ...session,
                source: params.expected,
                target: params.target,
                ...("abandonSource" in params ? { abandonSource: true } : {}),
              },
              () =>
                emitSessionsChanged(context, {
                  reason: "move",
                  sessionKey,
                }),
              authorize,
            ),
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
    });
  },
  "sessions.reclaim": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsReclaimParams, "sessions.reclaim", respond)) {
      return;
    }
    return withWorkerSessionTarget("reclaim", params, context, respond, async (resolved) => {
      const { entry, session, service: placementService } = resolved;
      const { sessionId, sessionKey } = session;
      const existingPlacement = await readSessionWorkerPlacementAsync({ context, sessionId });
      sessionMutationAuthorization?.assertCurrent();
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
      if (
        existingPlacement?.state !== "failed" &&
        !(await resolveSessionWorkspace({
          config: context.getRuntimeConfig(),
          entry,
          ...session,
          method: "sessions.reclaim",
          respond,
          assertCurrent: sessionMutationAuthorization?.assertCurrent,
        }))
      ) {
        return;
      }
      let placement: WorkerSessionPlacementRecord;
      try {
        placement = await placementService.reclaim!(
          {
            ...session,
            ...(params.recoverToGateway ? { recoverToGateway: params.recoverToGateway } : {}),
          },
          sessionMutationAuthorization?.assertCurrent,
        );
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        reportPlacementChange(await readSessionWorkerPlacementAsync({ context, sessionId }));
        respondWorkerDispatchError(error, respond);
        return;
      }
      reportPlacementChange(placement);
      respondWorkerPlacement({ respond, key: sessionKey, sessionId, context, placement });
    });
  },
};
