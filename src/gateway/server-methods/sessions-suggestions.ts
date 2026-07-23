import {
  ErrorCodes,
  errorShape,
  validateSessionSuggestionsAddParams,
  validateSessionSuggestionsListParams,
  validateSessionSuggestionsResolveParams,
  validateSessionTypingParams,
  type SessionSuggestion,
  type SessionSuggestionEvent,
  type SessionSuggestionResolution,
  type SessionSharingIdentity,
  type SessionTypingEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  addSessionSuggestion,
  claimSessionSuggestionDispatch,
  finalizeSessionSuggestionClaim,
  listSessionSuggestions,
  releaseSessionSuggestionDispatch,
  SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
  type StoredSessionSuggestion,
} from "../../config/sessions.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import {
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "../session-sharing.js";
import { handleChatSend } from "./chat-send-handler.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { appendSessionAudit } from "./session-audit.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

const TYPING_THROTTLE_MS = 1_000;
const TYPING_ACTIVE_TTL_MS = 2_500;
const MAX_TYPING_THROTTLE_KEYS = 2_048;
const typingBroadcastState = new Map<string, { at: number; typing: boolean }>();
const typingConnections = new Map<string, Map<string, number>>();

function suggestionScope(target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>) {
  return {
    agentId: target.agentId,
    sessionKey: target.storeKey,
    storePath: target.storePath,
  };
}

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

function requireSuggestionTarget(params: {
  context: GatewayRequestContext;
  sessionKey: string;
  agentId?: string;
  respond: RespondFn;
}) {
  const target = resolveSessionSharingTarget({
    cfg: params.context.getRuntimeConfig(),
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (!target) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.sessionKey}`),
    );
    return null;
  }
  return target;
}

function publishSuggestion(context: GatewayRequestContext, event: SessionSuggestionEvent): void {
  context.broadcast("session.suggestion", event, {
    sessionKeys: [event.suggestion.sessionKey],
    agentId: event.suggestion.agentId,
  });
}

function resolutionState(resolution: SessionSuggestionResolution): "accepted" | "dismissed" {
  return resolution === "dismiss" ? "dismissed" : "accepted";
}

function resolutionLabel(resolution: SessionSuggestionResolution): string {
  switch (resolution) {
    case "send":
      return "sent immediately";
    case "queue":
      return "queued";
    case "edit":
      return "moved into the composer";
    case "dismiss":
      return "dismissed";
  }
  throw new Error(`unsupported suggestion resolution: ${String(resolution)}`);
}

function actorIdentity(client: GatewayClient | null): SessionSharingIdentity {
  return (
    gatewayClientSessionCreator(client) ?? {
      type: "system",
      id: "operator.admin",
      label: "Administrator",
    }
  );
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
}): Promise<{ ok: true } | { ok: false; error: Parameters<RespondFn>[2] }> {
  let response: Parameters<RespondFn> | undefined;
  const chatParams = {
    sessionKey: params.target.canonicalKey,
    agentId: params.target.agentId,
    sessionId: params.target.entry.sessionId,
    message: params.suggestion.text,
    queueMode: params.resolution === "send" ? "steer" : "followup",
    idempotencyKey: `session-suggestion:${params.suggestion.id}`,
  };
  await handleChatSend({
    req: { ...params.req, method: "chat.send", params: chatParams },
    params: chatParams,
    client: attributedSuggestionClient(params.client, params.suggestion),
    isWebchatConnect: params.isWebchatConnect,
    respond: (...args) => {
      response = args;
    },
    context: params.context,
  });
  return response?.[0] === true ? { ok: true } : { ok: false, error: response?.[2] };
}

function liveViewerIdentities(sessionKeys: ReadonlySet<string>): Set<string> {
  return new Set(
    listSystemPresence()
      .filter(
        (entry) =>
          entry.user?.id &&
          entry.watchedSessions?.some((sessionKey) => sessionKeys.has(sessionKey)),
      )
      .map((entry) => entry.user?.id)
      .filter((id): id is string => Boolean(id)),
  );
}

function shouldBroadcastTyping(key: string, typing: boolean, now: number): boolean {
  const previous = typingBroadcastState.get(key);
  if (previous && previous.typing !== typing) {
    typingBroadcastState.delete(key);
    typingBroadcastState.set(key, { at: now, typing });
    return true;
  }
  if (previous && now - previous.at < TYPING_THROTTLE_MS) {
    return false;
  }
  typingBroadcastState.delete(key);
  typingBroadcastState.set(key, { at: now, typing });
  if (typingBroadcastState.size > MAX_TYPING_THROTTLE_KEYS) {
    typingBroadcastState.delete(typingBroadcastState.keys().next().value ?? "");
  }
  return true;
}

function updateTypingConnections(params: {
  key: string;
  connectionId: string;
  typing: boolean;
  now: number;
}): boolean {
  for (const [typingKey, activeConnections] of typingConnections) {
    for (const [connectionId, updatedAt] of activeConnections) {
      if (params.now - updatedAt >= TYPING_ACTIVE_TTL_MS) {
        activeConnections.delete(connectionId);
      }
    }
    if (activeConnections.size === 0) {
      typingConnections.delete(typingKey);
    }
  }
  const connections = typingConnections.get(params.key) ?? new Map<string, number>();
  if (params.typing) {
    connections.set(params.connectionId, params.now);
  } else {
    connections.delete(params.connectionId);
  }
  if (connections.size === 0) {
    typingConnections.delete(params.key);
    return false;
  }
  typingConnections.delete(params.key);
  typingConnections.set(params.key, connections);
  if (typingConnections.size > MAX_TYPING_THROTTLE_KEYS) {
    typingConnections.delete(typingConnections.keys().next().value ?? "");
  }
  return true;
}

export const sessionSuggestionHandlers: GatewayRequestHandlers = {
  "session.suggestions.add": ({ params, respond, client, context }) => {
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
    const target = requireSuggestionTarget({ context, ...params, respond });
    const author = gatewayClientSessionCreator(client);
    if (!target) {
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
    if (resolveSessionVisibility(target.entry) !== "suggest") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session is not accepting suggestions"),
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
    let suggestion: StoredSessionSuggestion;
    try {
      suggestion = addSessionSuggestion(suggestionScope(target), {
        authorId: author.id,
        authorLabel: author.label,
        text,
        expectedSessionId: target.entry.sessionId,
      });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "suggestion could not be stored",
        ),
      );
      return;
    }
    const projected = protocolSuggestion(target, suggestion);
    publishSuggestion(context, { action: "added", suggestion: projected });
    respond(true, { suggestion: projected });
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
    const target = requireSuggestionTarget({ context, ...params, respond });
    if (!target) {
      return;
    }
    const role = resolveSessionSharingRole({ client, target });
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
    const target = requireSuggestionTarget({ context, ...params, respond });
    if (!target) {
      return;
    }
    const role = resolveSessionSharingRole({ client, target });
    if (role !== "owner" && role !== "admin") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session owner or operator.admin required"),
      );
      return;
    }
    const resolution = params.resolution as SessionSuggestionResolution;
    if ((resolution === "send" || resolution === "queue") && !client) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "connected client required for suggestion dispatch"),
      );
      return;
    }
    const scope = suggestionScope(target);
    const dispatching = resolution === "send" || resolution === "queue";
    const claim = claimSessionSuggestionDispatch(scope, {
      id: params.id,
      expectedSessionId: target.entry.sessionId,
    });
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
    if (dispatching && client) {
      try {
        const dispatched = await dispatchSuggestion({
          context,
          client,
          req,
          isWebchatConnect,
          target,
          suggestion: claim.suggestion,
          resolution,
        });
        if (!dispatched.ok) {
          releaseSessionSuggestionDispatch(scope, {
            id: claim.suggestion.id,
            token: claim.token,
            expectedSessionId: target.entry.sessionId,
          });
          respond(
            false,
            undefined,
            dispatched.error ??
              errorShape(ErrorCodes.INVALID_REQUEST, "suggestion dispatch failed"),
          );
          return;
        }
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
    }
    const suggestion = finalizeSessionSuggestionClaim(scope, {
      id: claim.suggestion.id,
      token: claim.token,
      state: resolutionState(resolution),
      expectedSessionId: target.entry.sessionId,
    });
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
    const projected = protocolSuggestion(target, suggestion);
    const actor = actorIdentity(client);
    try {
      await appendSessionAudit({
        cfg: context.getRuntimeConfig(),
        target,
        text: `${actor.label ?? actor.id} ${resolutionLabel(resolution)} suggestion from ${suggestion.authorLabel ?? suggestion.authorId}.`,
        now: Date.now(),
      });
    } catch (error) {
      context.logGateway.warn(`failed to append suggestion resolution audit: ${String(error)}`);
    }
    publishSuggestion(context, { action: "resolved", suggestion: projected });
    respond(true, { suggestion: projected });
  },

  "session.typing": ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateSessionTypingParams, "session.typing", respond)) {
      return;
    }
    const target = requireSuggestionTarget({ context, ...params, respond });
    const actor = gatewayClientSessionCreator(client);
    if (!target) {
      return;
    }
    if (!actor) {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    const role = resolveSessionSharingRole({ client, target });
    const visibility = resolveSessionVisibility(target.entry);
    if (role === "viewer" && visibility !== "shared" && visibility !== "suggest") {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    const sessionKeys = new Set([params.sessionKey, target.canonicalKey, target.storeKey]);
    const liveIdentities = liveViewerIdentities(sessionKeys);
    if (liveIdentities.size < 2 || !liveIdentities.has(actor.id)) {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    const now = Date.now();
    const typingKey = `${actor.id}\0${target.agentId}\0${target.canonicalKey}`;
    const effectiveTyping = updateTypingConnections({
      key: typingKey,
      connectionId: client?.connId ?? actor.id,
      typing: params.typing,
      now,
    });
    if (
      (!params.typing && effectiveTyping) ||
      !shouldBroadcastTyping(typingKey, effectiveTyping, now)
    ) {
      respond(true, { ok: true, broadcast: false });
      return;
    }
    const event: SessionTypingEvent = {
      sessionKey: target.canonicalKey,
      agentId: target.agentId,
      actor,
      typing: effectiveTyping,
      ts: now,
    };
    context.broadcast("session.typing", event, {
      sessionKeys: [...sessionKeys].toSorted(),
      agentId: target.agentId,
      dropIfSlow: true,
    });
    respond(true, { ok: true, broadcast: true });
  },
};
