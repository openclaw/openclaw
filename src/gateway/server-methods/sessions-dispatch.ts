// Cloud-worker dispatch for managed-worktree sessions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsDispatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-create-service.js";
import { projectWorkerSessionPlacement } from "../worker-environments/placement-projector.js";
import {
  isWorkerPlacementSessionRuntimeSupported,
  resolveWorkerPlacementSessionRuntime,
} from "../worker-environments/placement-session-runtime.js";
import {
  isWorkerDispatchInputError,
  loadAccessorSessionEntryForGatewayTarget,
  rejectWebchatSessionMutation,
  requireSessionKey,
} from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionDispatchHandlers: GatewayRequestHandlers = {
  "sessions.dispatch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsDispatchParams, "sessions.dispatch", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "dispatch", client, isWebchatConnect, respond })) {
      return;
    }
    const dispatchService = context.workerPlacementDispatchService;
    const placementReader = context.workerSessionPlacementService;
    if (!dispatchService || !placementReader) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "cloud worker dispatch is not configured"),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, params.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    if (!Object.hasOwn(cfg.cloudWorkers?.profiles ?? {}, params.profileId)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `cloud worker profile is not configured: ${params.profileId}`,
        ),
      );
      return;
    }
    const target = loadAccessorSessionEntryForGatewayTarget({
      key,
      cfg,
      agentId: requestedAgent.agentId,
    });
    const entry = target.entry;
    const sessionId = normalizeOptionalString(entry?.sessionId);
    if (!entry || !sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    if (entry.archivedAt !== undefined) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "cannot dispatch an archived session"),
      );
      return;
    }
    const sessionRuntime = resolveWorkerPlacementSessionRuntime({
      cfg,
      entry,
      agentId: target.target.agentId,
      sessionKey: target.canonicalKey,
    });
    if (!isWorkerPlacementSessionRuntimeSupported(sessionRuntime)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `cloud worker dispatch requires the OpenClaw runtime, not ${sessionRuntime}`,
        ),
      );
      return;
    }
    const existingPlacement = placementReader.getMany([sessionId]).get(sessionId);
    if (
      existingPlacement &&
      existingPlacement.state !== "local" &&
      existingPlacement.state !== "reclaimed"
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `session cannot dispatch from placement ${existingPlacement.state}`,
        ),
      );
      return;
    }
    const worktree = managedWorktrees.findLiveByOwner("session", target.canonicalKey);
    if (
      !target.entry?.worktree?.id ||
      !worktree ||
      worktree.id !== target.entry.worktree.id ||
      worktree.ownerId !== target.canonicalKey
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "sessions.dispatch requires a session-owned managed worktree",
        ),
      );
      return;
    }
    try {
      const placement = await dispatchService.dispatch({
        sessionId,
        sessionKey: target.canonicalKey,
        agentId: target.target.agentId,
        profileId: params.profileId,
      });
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          sessionId,
          placement: projectWorkerSessionPlacement(placement),
        },
        undefined,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          isWorkerDispatchInputError(error) ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
          formatErrorMessage(error),
        ),
      );
    }
  },
};
