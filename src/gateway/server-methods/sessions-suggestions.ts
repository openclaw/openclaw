import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import {
  ErrorCodes,
  errorShape,
  validateSessionSuggestionsAddParams,
  validateSessionSuggestionsListParams,
  validateSessionSuggestionsResolveParams,
  validateSessionTypingParams,
  type SessionSuggestion,
  type SessionSuggestionResolution,
  type SessionTypingEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  addSessionSuggestion,
  claimSessionSuggestionDispatch,
  finalizeSessionSuggestionClaim,
  isSessionWorkStartInvalidatedError,
  listSessionSuggestions,
  releaseSessionSuggestionDispatch,
  SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
  type StoredSessionSuggestion,
} from "../../config/sessions.js";
import { presenceUserKey } from "../../shared/presence-user.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import {
  authorizeIncognitoSessionTarget,
  canManageSessionSharing,
  resolveSessionSharingRole,
  resolveSessionMutationAuthorization,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { resolveSessionSubscriptionKeys as subscriptionKeys } from "../session-subscription-keys.js";
import { handleChatSend } from "./chat-send-handler.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { withSessionMutationCommitGuard } from "./session-mutation-guards.js";
import {
  broadcastTypingThrottled,
  liveViewerIdentities,
  TYPING_PREVIEW_THROTTLE_MS,
  TYPING_THROTTLE_MS,
  updateTypingConnections,
} from "./session-typing-state.js";
import {
  authorizeSessionSuggestionMutation,
  createSessionSuggestionMutation,
  resolveCurrentSuggestionTarget,
  respondSessionSuggestionSessionChanged,
  suggestionScope,
  type SessionSuggestionMutationResult,
  publishSuggestion,
  requireSuggestionTarget,
  requireVisibleSuggestionRole,
} from "./sessions-suggestions-access.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
  SessionMutationAuthorization,
} from "./types.js";
import { assertValidParams } from "./validation.js";

function protocolSuggestion(
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>,
  suggestion: StoredSessionSuggestion,
): SessionSuggestion {
  return {
    id: suggestion.id,
    sessionKey: target.canonicalKey,
    agentId: target.agentId,
    author: {
      type: "human",
      id: suggestion.authorId,
      ...(suggestion.authorLabel ? { label: suggestion.authorLabel } : {}),
    },
    text: suggestion.text,
    createdAt: suggestion.createdAt,
    state: suggestion.state,
  };
}

function resolutionState(resolution: SessionSuggestionResolution): "accepted" | "dismissed" {
  return resolution === "dismiss" ? "dismissed" : "accepted";
}

function attributedSuggestionClient(
  client: GatewayClient,
  suggestion: StoredSessionSuggestion,
): GatewayClient {
  const label = suggestion.authorLabel ?? suggestion.authorId;
  return {
    ...client,
    internal: {
      ...client.internal,
      syntheticClient: true,
      senderAttribution: {
        id: suggestion.authorId,
        identity: { type: "profile", id: suggestion.authorId },
        name: `Suggested by ${label}`,
      },
    },
  };
}

async function dispatchSuggestion(params: {
  context: GatewayRequestContext;
  client: GatewayClient;
  req: Parameters<GatewayRequestHandlers[string]>[0]["req"];
  isWebchatConnect: Parameters<GatewayRequestHandlers[string]>[0]["isWebchatConnect"];
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
  suggestion: StoredSessionSuggestion;
  resolution: "send" | "queue";
  expectedSessionId: string | undefined;
  signal?: AbortSignal;
  sessionMutationAuthorization?: SessionMutationAuthorization;
}): Promise<{ ok: true } | { ok: false; error: Parameters<RespondFn>[2] }> {
  let response: Parameters<RespondFn> | undefined;
  const chatParams = {
    sessionKey: params.target.canonicalKey,
    agentId: params.target.agentId,
    sessionId: params.expectedSessionId,
    message: params.suggestion.text,
    ...(params.resolution === "queue"
      ? { queueMode: "followup" as const }
      : { queueMode: "steer" as const }),
    idempotencyKey: `session-suggestion:${params.suggestion.id}`,
  };
  const captureResponse: RespondFn = (...args) => {
    response = args;
  };
  const chatClient = attributedSuggestionClient(params.client, params.suggestion);
  const assertRequestCurrent = () => {
    params.signal?.throwIfAborted();
    params.sessionMutationAuthorization?.assertCurrent();
  };
  const assertAdmittedCurrent =
    params.sessionMutationAuthorization?.assertAdmittedInputCurrent ??
    params.sessionMutationAuthorization?.assertCurrent;
  let chatAuthorization: SessionMutationAuthorization | undefined;
  try {
    assertRequestCurrent();
    const cfg = params.context.getRuntimeConfig();
    const current = resolveCurrentSuggestionTarget(params.target, params.expectedSessionId, cfg);
    if (
      !authorizeSessionSuggestionMutation(
        {
          client: params.client,
          cfg,
          target: current,
          sessionKey: params.target.canonicalKey,
          respond: captureResponse,
        },
        params.resolution,
      )
    ) {
      return { ok: false, error: response?.[2] };
    }
    const authorization = resolveSessionMutationAuthorization({
      client: chatClient,
      method: "chat.send",
      requestParams: chatParams,
      context: params.context,
    });
    if (authorization.error) {
      return { ok: false, error: authorization.error };
    }
    chatAuthorization = withSessionMutationCommitGuard(
      authorization.authorization,
      assertAdmittedCurrent,
      assertRequestCurrent,
    );
    chatAuthorization?.assertCurrent();
  } catch (error) {
    // No chat invocation occurred, so the caller can release its exact claim.
    if (error instanceof SessionMutationAuthorizationChangedError) {
      return { ok: false, error: error.error };
    }
    if (isSessionWorkStartInvalidatedError(error)) {
      respondSessionSuggestionSessionChanged(captureResponse, params.target.canonicalKey);
      return { ok: false, error: response?.[2] };
    }
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        error instanceof Error ? error.message : "suggestion dispatch authorization failed",
      ),
    };
  }
  await handleChatSend({
    req: { ...params.req, method: "chat.send", params: chatParams },
    params: chatParams,
    client: chatClient,
    isWebchatConnect: params.isWebchatConnect,
    respond: captureResponse,
    sessionMutationAuthorization: chatAuthorization,
    sessionMutationCommitGuard: assertRequestCurrent,
    context: params.context,
  });
  return response?.[0] === true ? { ok: true } : { ok: false, error: response?.[2] };
}

export const sessionSuggestionHandlers: GatewayRequestHandlers = {
  "session.suggestions.add": async ({
    params,
    respond,
    client,
    context,
    signal,
    sessionMutationAuthorization,
  }) => {
    if (
      !assertValidParams(
        params,
        validateSessionSuggestionsAddParams,
        "session.suggestions.add",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const target = requireSuggestionTarget({ client, context, ...params, respond });
    const author = gatewayClientSessionCreator(client);
    if (
      !target ||
      !authorizeSessionSuggestionMutation(
        { client, cfg, sessionKey: params.sessionKey, target, respond },
        "add",
      )
    ) {
      return;
    }
    if (!author) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "identified suggestion author required"),
      );
      return;
    }
    const text = params.text;
    if (!text.trim()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "suggestion text is required"),
      );
      return;
    }
    const expectedSessionId = target.entry.sessionId;
    const mutate = createSessionSuggestionMutation({
      target,
      context,
      client,
      respond,
      sessionKey: params.sessionKey,
      signal,
      assertCurrent: sessionMutationAuthorization?.assertCurrent,
    });
    try {
      const added = await mutate({
        kind: "start",
        action: "add",
        mutate: (scope) => {
          const suggestion = addSessionSuggestion(scope, {
            authorId: author.id,
            authorLabel: author.label,
            text,
            expectedSessionId,
          });
          const projected = protocolSuggestion(target, suggestion);
          publishSuggestion(context, target, params.sessionKey, {
            action: "added",
            suggestion: projected,
          });
          return projected;
        },
      });
      if (added.ok) {
        respond(true, { suggestion: added.value });
      }
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "suggestion could not be stored",
        ),
      );
    }
  },

  "session.suggestions.list": ({ params, respond, client, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionSuggestionsListParams,
        "session.suggestions.list",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const target = requireSuggestionTarget({ client, context, ...params, respond });
    if (!target) {
      return;
    }
    const role = requireVisibleSuggestionRole({
      client,
      cfg,
      sessionKey: params.sessionKey,
      target,
      respond,
    });
    if (role === null) {
      return;
    }
    const identity = gatewayClientSessionCreator(client);
    const stored =
      role === "viewer"
        ? identity
          ? listSessionSuggestions(suggestionScope(target), { authorId: identity.id })
          : []
        : listSessionSuggestions(suggestionScope(target)).filter(
            (suggestion) => suggestion.state === "pending" || suggestion.authorId === identity?.id,
          );
    respond(true, {
      role,
      suggestions: stored.map((suggestion) => protocolSuggestion(target, suggestion)),
    });
  },

  "session.suggestions.resolve": async ({
    params,
    respond,
    client,
    context,
    req,
    isWebchatConnect,
    signal,
    sessionMutationAuthorization,
  }) => {
    if (
      !assertValidParams(
        params,
        validateSessionSuggestionsResolveParams,
        "session.suggestions.resolve",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const target = requireSuggestionTarget({ client, context, ...params, respond });
    if (!target) {
      return;
    }
    const resolution = params.resolution as SessionSuggestionResolution;
    const dispatching = resolution === "send" || resolution === "queue";
    if (
      !authorizeSessionSuggestionMutation(
        { client, cfg, sessionKey: params.sessionKey, target, respond },
        resolution,
      )
    ) {
      return;
    }
    if (dispatching && !client) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "connected client required for suggestion dispatch"),
      );
      return;
    }
    const expectedSessionId = target.entry.sessionId;
    const mutate = createSessionSuggestionMutation({
      target,
      context,
      client,
      respond,
      sessionKey: params.sessionKey,
      signal,
      assertCurrent: sessionMutationAuthorization?.assertCurrent,
    });
    const claimResult = await mutate({
      kind: "start",
      action: resolution,
      mutate: (scope) =>
        claimSessionSuggestionDispatch(scope, {
          id: params.id,
          resolution,
          expectedSessionId,
        }),
    });
    if (!claimResult.ok) {
      return;
    }
    const claim = claimResult.value;
    if (!claim) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "pending suggestion not found"),
      );
      return;
    }
    if (claim.kind === "busy") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "suggestion resolution is already in progress", {
          retryable: true,
          retryAfterMs: SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
        }),
      );
      return;
    }
    if (claim.kind === "mismatch") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `suggestion dispatch recovery must retry the original ${claim.resolution} action`,
        ),
      );
      return;
    }
    if (dispatching && client) {
      let dispatched: Awaited<ReturnType<typeof dispatchSuggestion>>;
      try {
        dispatched = await dispatchSuggestion({
          context,
          client,
          req,
          isWebchatConnect,
          target,
          suggestion: claim.suggestion,
          resolution,
          expectedSessionId,
          signal,
          sessionMutationAuthorization,
        });
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error instanceof Error ? error.message : "suggestion dispatch outcome is unknown",
            {
              retryable: true,
              retryAfterMs: SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
            },
          ),
        );
        return;
      }
      if (!dispatched.ok) {
        let releaseResult: SessionSuggestionMutationResult<boolean>;
        try {
          releaseResult = await mutate({
            kind: "settle",
            mutate: (scope) =>
              releaseSessionSuggestionDispatch(scope, {
                id: claim.suggestion.id,
                token: claim.token,
                expectedSessionId,
              }),
          });
        } catch (error) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              error instanceof Error ? error.message : "suggestion dispatch outcome is unknown",
              {
                retryable: true,
                retryAfterMs: SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
              },
            ),
          );
          return;
        }
        if (!releaseResult.ok) {
          return;
        }
        respond(
          false,
          undefined,
          dispatched.error ?? errorShape(ErrorCodes.INVALID_REQUEST, "suggestion dispatch failed"),
        );
        return;
      }
    }
    const finalizeResult = await mutate({
      kind: "settle",
      mutate: (scope) => {
        const suggestion = finalizeSessionSuggestionClaim(scope, {
          id: claim.suggestion.id,
          token: claim.token,
          state: resolutionState(resolution),
          expectedSessionId,
        });
        if (!suggestion) {
          return null;
        }
        const projected = protocolSuggestion(target, suggestion);
        publishSuggestion(context, target, params.sessionKey, {
          action: "resolved",
          suggestion: projected,
        });
        return projected;
      },
    });
    if (!finalizeResult.ok) {
      return;
    }
    const suggestion = finalizeResult.value;
    if (!suggestion) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "suggestion resolution could not be finalized", {
          retryable: true,
        }),
      );
      return;
    }
    respond(true, { suggestion });
  },

  "session.typing": ({ params: requestParams, respond, client, context }) => {
    const params =
      typeof requestParams.preview === "string"
        ? {
            ...requestParams,
            preview: truncateCodePoints(requestParams.preview.trim(), 400),
          }
        : requestParams;
    if (!assertValidParams(params, validateSessionTypingParams, "session.typing", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const target = requireSuggestionTarget({ client, context, ...params, respond });
    const actor = gatewayClientSessionCreator(client);
    if (!target) {
      return;
    }
    const incognitoError = authorizeIncognitoSessionTarget({
      client,
      sessionKey: params.sessionKey,
      target,
    });
    if (incognitoError) {
      respond(false, undefined, incognitoError);
      return;
    }
    if (params.sessionId !== target.entry.sessionId) {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    if (!actor) {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    const role = resolveSessionSharingRole({ client, cfg, target });
    const visibility = resolveSessionVisibility(target.entry);
    if (role === "viewer" && operatorSessionCap(client, cfg) === "view") {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    if (visibility === "draft" && !canManageSessionSharing(role)) {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    if (role === "viewer" && visibility !== "shared" && visibility !== "suggest") {
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
    const typingKey = `${actor.id}\0${target.agentId}\0${target.canonicalKey}\0${target.entry.sessionId}`;
    const { typing: effectiveTyping, preview } = updateTypingConnections({
      key: typingKey,
      connectionId: client?.connId ?? actor.id,
      typing: params.typing,
      ...(params.typing && params.preview ? { preview: params.preview } : {}),
      now,
    });
    const broadcast = broadcastTypingThrottled({
      key: typingKey,
      typing: effectiveTyping,
      signature: `${effectiveTyping}\0${preview ?? ""}`,
      intervalMs: preview ? TYPING_PREVIEW_THROTTLE_MS : TYPING_THROTTLE_MS,
      now,
      emit: () => {
        const current = resolveSessionSharingTarget({
          cfg: context.getRuntimeConfig(),
          sessionKey: params.sessionKey,
          agentId: target.agentId,
        });
        if (!current || current.entry.sessionId !== target.entry.sessionId) {
          return false;
        }
        const currentCfg = context.getRuntimeConfig();
        const currentRole = resolveSessionSharingRole({ client, cfg: currentCfg, target: current });
        const currentVisibility = resolveSessionVisibility(current.entry);
        if (currentRole === "viewer" && operatorSessionCap(client, currentCfg) === "view") {
          return false;
        }
        if (currentVisibility === "draft" && !canManageSessionSharing(currentRole)) {
          return false;
        }
        if (
          currentRole === "viewer" &&
          currentVisibility !== "shared" &&
          currentVisibility !== "suggest"
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
  },
};
