import {
  ErrorCodes,
  errorShape,
  validateSessionTypingParams,
  type SessionTypingEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import { presenceUserKey } from "../../shared/presence-user.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import { captureSessionSharingMemoryFacts } from "../session-sharing-incognito.js";
import { SessionMutationFactsUnavailableError } from "../session-sharing-preparation.js";
import {
  authorizeIncognitoSessionTarget,
  canManageSessionSharing,
  prepareProjectedSessionSharing,
  resolveSessionVisibility,
} from "../session-sharing.js";
import { resolveSessionSubscriptionKeys as subscriptionKeys } from "../session-subscription-keys.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import {
  broadcastTypingThrottled,
  liveViewerIdentities,
  normalizeTypingRequestParams,
  TYPING_PREVIEW_THROTTLE_MS,
  TYPING_THROTTLE_MS,
  updateTypingConnections,
} from "./session-typing-state.js";
import { readCollaborationTarget } from "./sessions-suggestions-access.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionTypingHandler: GatewayRequestHandlers[string] = async ({
  params: requestParams,
  respond,
  client,
  context,
  hasCurrentClientAuthority,
}) => {
  const params = normalizeTypingRequestParams(requestParams);
  if (!assertValidParams(params, validateSessionTypingParams, "session.typing", respond)) {
    return;
  }
  const projection = requireSessionRowProjection(context);
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
  }
  const query = { key: params.sessionKey, agentId: requestedAgent.agentId };
  const actorFacts = captureSessionSharingMemoryFacts(
    {
      sessionKey: query.key,
      agentId: query.agentId,
      resolved: null,
    },
    () => {
      if (
        client?.invalidated ||
        client?.connectionSignal?.aborted ||
        hasCurrentClientAuthority?.() === false
      ) {
        throw new SessionMutationFactsUnavailableError();
      }
    },
  );
  if (!actorFacts) {
    while (projection.needsMembershipPreparation()) {
      await projection.prepareMembership();
    }
  }
  const readTarget = () => readCollaborationTarget(projection, query, actorFacts);
  const incognitoError = authorizeIncognitoSessionTarget({
    client,
    sessionKey: query.key,
    target: null,
  });
  if (incognitoError) {
    respond(false, undefined, incognitoError);
    return;
  }
  const target = readTarget();
  const sharing = () =>
    prepareProjectedSessionSharing({
      cfg: projection.getPolicyConfig(),
      client,
      isMember: (value, identity) =>
        actorFacts
          ? actorFacts.readCurrent().membership.has(identity)
          : projection.hasMembership(value.storePath, value.storeKey, identity),
    });
  const prepared = sharing();
  if (
    !target ||
    (hasOperatorBoundary(client, projection.getPolicyConfig()) &&
      prepared.entryFilter?.(target.storeKey, target.entry) === false)
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.sessionKey}`),
    );
    return;
  }
  const denied = authorizeIncognitoSessionTarget({ client, sessionKey: query.key, target });
  if (denied) {
    respond(false, undefined, denied);
    return;
  }
  const canType = (current: NonNullable<ReturnType<typeof readTarget>>, access = sharing()) => {
    if (
      authorizeIncognitoSessionTarget({ client, sessionKey: query.key, target: current }) ||
      (hasOperatorBoundary(client, projection.getPolicyConfig()) &&
        access.entryFilter?.(current.storeKey, current.entry) === false)
    ) {
      return false;
    }
    const role = access.roleForTarget(current);
    const visibility = resolveSessionVisibility(current.entry);
    return (
      !(role === "viewer" && access.sessionCap === "view") &&
      (visibility !== "draft" || canManageSessionSharing(role)) &&
      (role !== "viewer" || visibility === "shared" || visibility === "suggest")
    );
  };
  const actor = gatewayClientSessionCreator(client);
  if (
    params.sessionId !== target.entry.sessionId ||
    !actor ||
    client?.invalidated ||
    client?.connectionSignal?.aborted ||
    hasCurrentClientAuthority?.() === false ||
    !canType(target, prepared)
  ) {
    respond(true, { ok: true, broadcast: false });
    return;
  }
  if (params.typing) {
    context.recordClientActivity?.(client);
  }
  const sessionKeys = new Set([
    params.sessionKey,
    target.canonicalKey,
    target.storeKey,
    sessionObserverScopeKey(target.canonicalKey, target.agentId),
  ]);
  const now = Date.now();
  const typingKey = `${actor.id}\0${target.agentId}\0${target.canonicalKey}\0${target.entry.sessionId}\0${target.entry.lifecycleRevision ?? 0}`;
  const {
    typing: effectiveTyping,
    preview,
    cursor,
  } = updateTypingConnections({
    key: typingKey,
    connectionId: client?.connId ?? actor.id,
    typing: params.typing,
    preview: params.preview,
    cursor: params.cursor,
    now,
  });
  const broadcast = broadcastTypingThrottled({
    key: typingKey,
    typing: effectiveTyping,
    signature: `${effectiveTyping}\0${preview ?? ""}\0${cursor ?? ""}`,
    intervalMs: preview ? TYPING_PREVIEW_THROTTLE_MS : TYPING_THROTTLE_MS,
    now,
    emit: () => {
      if (
        client?.invalidated ||
        client?.connectionSignal?.aborted ||
        hasCurrentClientAuthority?.() === false ||
        gatewayClientSessionCreator(client)?.id !== actor.id ||
        getSessionRowProjection(context) !== projection
      ) {
        return false;
      }
      const current = readTarget();
      if (
        !current ||
        current.generation !== target.generation ||
        current.storePath !== target.storePath ||
        current.entry.sessionId !== target.entry.sessionId ||
        current.entry.lifecycleRevision !== target.entry.lifecycleRevision ||
        !canType(current)
      ) {
        return false;
      }
      const liveIdentities = liveViewerIdentities(sessionKeys);
      const actorKey = presenceUserKey({
        id: actor.id,
        identity: { type: "profile", id: actor.id },
      });
      if (liveIdentities.size < 2 || !liveIdentities.has(actorKey)) {
        return false;
      }
      const event: SessionTypingEvent = {
        sessionKey: target.canonicalKey,
        sessionId: current.entry.sessionId,
        agentId: target.agentId,
        actor,
        typing: effectiveTyping,
        ...(preview ? { preview } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ts: Date.now(),
      };
      context.broadcast("session.typing", event, {
        sessionKeys: subscriptionKeys(
          current.canonicalKey,
          current.agentId,
          current.canonicalKey === "global"
            ? tryResolveSessionCompatibilityOwnerAgentId(
                context.getRuntimeConfig(),
                current.canonicalKey,
              )
            : undefined,
        ),
        agentId: target.agentId,
        dropIfSlow: true,
      });
      return true;
    },
  });
  respond(true, { ok: true, broadcast });
};
