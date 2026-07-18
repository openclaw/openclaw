import {
  ErrorCodes,
  errorShape,
  validateSessionsForkParams,
  validateSessionsRewindParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import {
  forkSessionAtMessage,
  rewindSessionToMessage,
  type SessionMessageCutMutationResult,
} from "../../config/sessions/session-accessor.js";
import {
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { readSessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import {
  buildDashboardSessionKey,
  resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId,
} from "../session-create-service.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import { hasVisibleActiveSessionRun } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  loadAccessorSessionEntryForGatewayTarget,
  rejectWebchatSessionMutation,
  resolveSessionWorkerPlacementMutationError,
  respondSessionWorkerPlacementMutationError,
} from "./sessions-shared.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type MessageCutAction = "fork" | "rewind";

const EXTERNAL_CONVERSATION_ERROR =
  "Rewind and fork are unavailable because this session is owned by an external agent harness.";

export const sessionRewindHandlers: GatewayRequestHandlers = {
  "sessions.rewind": async (options) => {
    if (
      !assertValidParams(
        options.params,
        validateSessionsRewindParams,
        "sessions.rewind",
        options.respond,
      )
    ) {
      return;
    }
    await mutateSessionAtMessage(options, "rewind");
  },
  "sessions.fork": async (options) => {
    if (
      !assertValidParams(
        options.params,
        validateSessionsForkParams,
        "sessions.fork",
        options.respond,
      )
    ) {
      return;
    }
    await mutateSessionAtMessage(options, "fork");
  },
};

async function mutateSessionAtMessage(
  options: GatewayRequestHandlerOptions,
  action: MessageCutAction,
): Promise<void> {
  const { params, respond, context, client, isWebchatConnect } = options;
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  const entryId = typeof params.entryId === "string" ? params.entryId.trim() : "";
  if (
    rejectWebchatSessionMutation({
      action,
      client,
      isWebchatConnect,
      respond,
    })
  ) {
    return;
  }
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(
    cfg,
    sessionKey,
    typeof params.agentId === "string" ? params.agentId : undefined,
  );
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
  }
  const initial = loadAccessorSessionEntryForGatewayTarget({
    key: sessionKey,
    cfg,
    agentId: requestedAgent.agentId,
  });
  if (!initial.entry?.sessionId) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${sessionKey}`),
    );
    return;
  }
  const initialSessionId = initial.entry.sessionId;
  const initialLifecycleRevision = initial.entry.lifecycleRevision;
  if (readSessionUpstreamLink(initial.canonicalKey, initial.target.agentId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, EXTERNAL_CONVERSATION_ERROR));
    return;
  }
  const initialPlacementError = resolveSessionWorkerPlacementMutationError({
    action,
    context,
    key: sessionKey,
    sessionId: initial.entry.sessionId,
  });
  if (initialPlacementError) {
    respondSessionWorkerPlacementMutationError(initialPlacementError, respond);
    return;
  }

  const lifecycleIdentities = [
    sessionKey,
    initial.canonicalKey,
    initial.sessionStoreKey,
    initialSessionId,
    initialLifecycleRevision,
  ];
  let targetStillCurrent = true;
  let blockedByActiveRun = false;
  await runExclusiveSessionLifecycleMutation({
    scope: initial.storePath,
    identities: [initialSessionId, initialLifecycleRevision],
    prepare: async () => {
      const current = loadAccessorSessionEntryForGatewayTarget({
        key: sessionKey,
        cfg,
        agentId: requestedAgent.agentId,
      });
      targetStillCurrent =
        current.entry?.sessionId === initialSessionId &&
        current.entry.lifecycleRevision === initialLifecycleRevision;
      if (!targetStillCurrent) {
        return;
      }
      // Fork cannot disturb its source, and rewind must not invalidate queued work on failure.
      // Reject live work before either transcript mutation instead of interrupting it.
      blockedByActiveRun =
        isCompetingSessionWorkAdmissionActive(initial.storePath, lifecycleIdentities) ||
        (asWorkerInferenceControl(context.workerEnvironmentService)?.hasInferenceForSession(
          initialSessionId,
        ) ??
          false) ||
        hasVisibleActiveSessionRun({
          context,
          requestedKey: sessionKey,
          canonicalKey: current.canonicalKey,
          sessionId: initialSessionId,
          agentId: requestedAgent.agentId,
          defaultAgentId: resolveDefaultAgentId(cfg),
        });
    },
    run: async () => {
      if (!targetStillCurrent) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Session ${sessionKey} changed; retry ${action}.`),
        );
        return;
      }
      if (blockedByActiveRun) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `${action === "fork" ? "Fork" : "Rewind"} is unavailable while the agent is working.`,
          ),
        );
        return;
      }
      const current = loadAccessorSessionEntryForGatewayTarget({
        key: sessionKey,
        cfg,
        agentId: requestedAgent.agentId,
      });
      if (
        current.entry?.sessionId !== initialSessionId ||
        current.entry.lifecycleRevision !== initialLifecycleRevision
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Session ${sessionKey} changed; retry ${action}.`),
        );
        return;
      }
      if (readSessionUpstreamLink(current.canonicalKey, current.target.agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, EXTERNAL_CONVERSATION_ERROR),
        );
        return;
      }
      const placementError = resolveSessionWorkerPlacementMutationError({
        action,
        context,
        key: sessionKey,
        sessionId: current.entry.sessionId,
      });
      if (placementError) {
        respondSessionWorkerPlacementMutationError(placementError, respond);
        return;
      }
      const targetKey =
        action === "fork" ? buildDashboardSessionKey(current.target.agentId) : current.canonicalKey;
      const result = await (action === "fork"
        ? forkSessionAtMessage({
            agentId: current.target.agentId,
            entryId,
            sessionKey: current.canonicalKey,
            sessionStoreKey: current.sessionStoreKey,
            storePath: current.storePath,
            targetKey,
          })
        : rewindSessionToMessage({
            agentId: current.target.agentId,
            entryId,
            sessionKey: current.canonicalKey,
            sessionStoreKey: current.sessionStoreKey,
            storePath: current.storePath,
          }));
      if (result.status !== "created") {
        respondMessageCutError(result, action, entryId, respond);
        return;
      }
      if (action === "rewind") {
        clearSessionQueues(lifecycleIdentities);
      }
      respond(
        true,
        action === "fork"
          ? {
              sessionKey: result.key,
              ...(result.editorText ? { editorText: result.editorText } : {}),
            }
          : result.editorText
            ? { editorText: result.editorText }
            : {},
        undefined,
      );
      emitSessionsChanged(context, {
        sessionKey: action === "fork" ? result.key : current.canonicalKey,
        ...((action === "fork" ? result.key : current.canonicalKey) === "global" &&
        requestedAgent.agentId
          ? { agentId: requestedAgent.agentId }
          : {}),
        reason: action,
      });
    },
  });
}

function respondMessageCutError(
  result: Exclude<SessionMessageCutMutationResult, { status: "created" }>,
  action: MessageCutAction,
  entryId: string,
  respond: GatewayRequestHandlerOptions["respond"],
): void {
  const message =
    result.status === "missing-session"
      ? "session not found"
      : result.status === "missing-entry"
        ? `message entry not found: ${entryId}`
        : result.status === "not-user-message"
          ? `entry is not a user message: ${entryId}`
          : result.status === "off-active-path"
            ? `message entry is not on the active path: ${entryId}`
            : result.status === "unsupported-storage"
              ? `session transcript storage does not support ${action}`
              : `failed to ${action} session`;
  respond(
    false,
    undefined,
    errorShape(
      result.status === "failed" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
      message,
    ),
  );
}
