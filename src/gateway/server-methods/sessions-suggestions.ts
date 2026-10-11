import {
  ErrorCodes,
  errorShape,
  validateSessionSuggestionsAddParams,
  validateSessionSuggestionsListParams,
  validateSessionSuggestionsResolveParams,
  validateSessionTypingParams,
  type SessionSuggestion,
  type SessionSuggestionEvent,
  type SessionTypingEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  listSessionSuggestions,
  SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
  type StoredSessionSuggestion,
} from "../../config/sessions.js";
import { captureIncognitoSessionBinding } from "../../config/sessions/session-incognito-binding.js";
import {
  addSessionSuggestionInWorker,
  claimSessionSuggestionDispatchInWorker,
  finalizeSessionSuggestionClaimInWorker,
  releaseSessionSuggestionDispatchInWorker,
} from "../../config/sessions/session-metadata-write.async.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { presenceUserKey } from "../../shared/presence-user.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { withReadySessionRows, type SessionRowReadView } from "../session-row-prepared-read.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import { captureIncognitoSessionMutationFacts } from "../session-sharing-incognito.js";
import { SessionMutationFactsUnavailableError } from "../session-sharing-preparation.js";
import {
  authorizeIncognitoSessionTarget,
  canManageSessionSharing,
  prepareProjectedSessionSharing,
  resolveSessionSharingTarget,
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
import { sharingExpectedEntry } from "./sessions-sharing-authority.js";
import {
  authorizeSessionSuggestionMutation,
  createSessionSuggestionMutation,
  suggestionScope,
  requireSuggestionTarget,
  readCollaborationTarget,
  requireVisibleSuggestionRole,
} from "./sessions-suggestions-access.js";
import { dispatchSuggestion } from "./sessions-suggestions-dispatch.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler } from "./validation.js";

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

function publishSuggestion(
  context: GatewayRequestContext,
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>,
  requestedSessionKey: string,
  action: SessionSuggestionEvent["action"],
  stored: StoredSessionSuggestion,
): SessionSuggestion {
  const suggestion = protocolSuggestion(target, stored);
  context.broadcast(
    "session.suggestion",
    { action, suggestion },
    {
      sessionKeys: [
        ...new Set([requestedSessionKey, target.canonicalKey, target.storeKey]),
      ].toSorted(),
      agentId: suggestion.agentId,
    },
  );
  return suggestion;
}

function respondSuggestionDispatchError(respond: RespondFn, error: unknown): void {
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
}

export const sessionSuggestionHandlers: GatewayRequestHandlers = {
  "session.suggestions.add": defineValidatedGatewayHandler(
    "session.suggestions.add",
    validateSessionSuggestionsAddParams,
    async ({ params, respond, client, context, signal, sessionMutationAuthorization }) => {
      const cfg = context.getCommittedRuntimeConfig?.() ?? context.getRuntimeConfig();
      const target = requireSuggestionTarget({ context, ...params, respond });
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
      const expectedEntry = {
        ...sharingExpectedEntry(target),
        lifecycleRevision: target.entry.lifecycleRevision,
      };
      const mutation = await createSessionSuggestionMutation({
        target,
        context,
        client,
        respond,
        sessionKey: params.sessionKey,
        signal,
        assertCurrent: sessionMutationAuthorization?.assertCurrent,
      });
      try {
        const added = await mutation.run({
          kind: "start",
          action: "add",
          mutate: async (scope, assertCurrent) => {
            const suggestion = await addSessionSuggestionInWorker(
              scope,
              {
                authorId: author.id,
                authorLabel: author.label,
                text,
                expectedSessionId,
                expectedEntry,
              },
              assertCurrent,
            );
            mutation.readCurrent();
            return publishSuggestion(context, target, params.sessionKey, "added", suggestion);
          },
        });
        if (added.ok) {
          respond(true, { suggestion: added.value });
        } else {
          respond(false, undefined, added.error);
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
      } finally {
        mutation.release();
      }
    },
  ),

  "session.suggestions.list": defineValidatedGatewayHandler(
    "session.suggestions.list",
    validateSessionSuggestionsListParams,
    async ({ params, respond, client, context, signal, hasCurrentClientAuthority }) => {
      const cfg = context.getRuntimeConfig();
      const requested = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
      if (!requested.ok) {
        respond(false, undefined, requested.error);
        return;
      }
      const identity = gatewayClientSessionCreator(client);
      const projection = requireSessionRowProjection(context);
      const query = { key: params.sessionKey, agentId: requested.agentId };
      const binding = captureIncognitoSessionBinding({
        sessionKey: query.key,
        agentId: query.agentId,
      });
      const actorFacts = binding && captureIncognitoSessionMutationFacts(binding, query.key, true);
      if (!binding) {
        while (projection.needsMembershipPreparation()) {
          await projection.prepareMembership();
        }
      }
      let selected: ReturnType<typeof readCollaborationTarget> = undefined;
      const readCurrent = (read: Pick<SessionRowReadView, "describe"> = projection) => {
        if (
          signal?.aborted ||
          client?.invalidated ||
          client?.connectionSignal?.aborted ||
          hasCurrentClientAuthority?.() === false ||
          gatewayClientSessionCreator(client)?.id !== identity?.id
        ) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.FORBIDDEN, "suggestion reader authority changed"),
          );
          return null;
        }
        const target = readCollaborationTarget(projection, query, read, actorFacts);
        if (
          getSessionRowProjection(context) !== projection ||
          (selected &&
            (!target ||
              target.generation !== selected.generation ||
              target.storePath !== selected.storePath ||
              target.entry.sessionId !== selected.entry.sessionId ||
              target.entry.lifecycleRevision !== selected.entry.lifecycleRevision))
        ) {
          throw new SessionMutationFactsUnavailableError();
        }
        const policy = (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)();
        const sharing = prepareProjectedSessionSharing({
          cfg: policy,
          client,
          isMember: (value, id) =>
            actorFacts
              ? actorFacts.readCurrent().membership.has(id)
              : projection.hasMembership(value.storePath, value.storeKey, id),
        });
        const role = requireVisibleSuggestionRole({
          client,
          cfg: policy,
          sessionKey: params.sessionKey,
          target: target ?? null,
          respond,
          sharing,
        });
        return role === null || !target ? null : { target, role };
      };
      const initial =
        isIncognitoSessionKey(query.key) && !binding
          ? await withReadySessionRows(projection, () => [query], readCurrent)
          : readCurrent();
      if (!initial) {
        return;
      }
      selected = initial.target;
      const stored = await listSessionSuggestions(suggestionScope(initial.target));
      const reply = (read?: Pick<SessionRowReadView, "describe">) => {
        const current = readCurrent(read);
        if (!current) {
          return;
        }
        const visible = stored.filter(
          (suggestion) =>
            suggestion.authorId === identity?.id ||
            (current.role !== "viewer" && suggestion.state === "pending"),
        );
        respond(true, {
          role: current.role,
          suggestions: visible.map((suggestion) => protocolSuggestion(current.target, suggestion)),
        });
      };
      if (isIncognitoSessionKey(query.key) && !binding) {
        await withReadySessionRows(projection, () => [query], reply);
      } else {
        reply();
      }
    },
  ),

  "session.suggestions.resolve": defineValidatedGatewayHandler(
    "session.suggestions.resolve",
    validateSessionSuggestionsResolveParams,
    async ({
      params,
      respond,
      client,
      context,
      req,
      isWebchatConnect,
      signal,
      sessionMutationAuthorization,
    }) => {
      const cfg = context.getCommittedRuntimeConfig?.() ?? context.getRuntimeConfig();
      const target = requireSuggestionTarget({ context, ...params, respond });
      if (!target) {
        return;
      }
      const resolution = params.resolution;
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
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "connected client required for suggestion dispatch",
          ),
        );
        return;
      }
      const expectedSessionId = target.entry.sessionId;
      const expectedEntry = {
        ...sharingExpectedEntry(target),
        lifecycleRevision: target.entry.lifecycleRevision,
      };
      const mutation = await createSessionSuggestionMutation({
        target,
        context,
        client,
        respond,
        sessionKey: params.sessionKey,
        signal,
        assertCurrent: sessionMutationAuthorization?.assertCurrent,
      });
      try {
        const claimResult = await mutation.run({
          kind: "start",
          action: resolution,
          mutate: (scope, assertCurrent) =>
            claimSessionSuggestionDispatchInWorker(
              scope,
              {
                id: params.id,
                resolution,
                expectedSessionId,
                expectedEntry,
              },
              assertCurrent,
            ),
        });
        if (!claimResult.ok) {
          respond(false, undefined, claimResult.error);
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
        const releaseClaim = async (): Promise<boolean> => {
          try {
            const released = await mutation.run({
              kind: "settle",
              mutate: (scope, assertCurrent) =>
                releaseSessionSuggestionDispatchInWorker(
                  scope,
                  { id: claim.suggestion.id, token: claim.token, expectedSessionId },
                  assertCurrent,
                ),
            });
            if (!released.ok) {
              respond(false, undefined, released.error);
            }
            return released.ok;
          } catch (error) {
            respondSuggestionDispatchError(respond, error);
            return false;
          }
        };
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
              readCurrent: mutation.readCurrent,
              signal,
              sessionMutationAuthorization,
            });
          } catch (error) {
            respondSuggestionDispatchError(respond, error);
            return;
          }
          if (!dispatched.ok) {
            if (!(await releaseClaim())) {
              return;
            }
            respond(
              false,
              undefined,
              dispatched.error ??
                errorShape(ErrorCodes.INVALID_REQUEST, "suggestion dispatch failed"),
            );
            return;
          }
        }
        const finalizeResult = await mutation.run({
          ...(dispatching
            ? { kind: "settle" as const }
            : { kind: "start" as const, action: resolution }),
          mutate: async (scope, assertCurrent) => {
            const suggestion = await finalizeSessionSuggestionClaimInWorker(
              scope,
              {
                id: claim.suggestion.id,
                token: claim.token,
                state: resolution === "dismiss" ? "dismissed" : "accepted",
                expectedSessionId,
                ...(!dispatching ? { expectedEntry } : {}),
              },
              assertCurrent,
            );
            mutation.readCurrent();
            if (!suggestion) {
              return null;
            }
            return publishSuggestion(context, target, params.sessionKey, "resolved", suggestion);
          },
        });
        if (!finalizeResult.ok) {
          // No input custody was transferred for edit/dismiss. Release only this
          // definite rejection; an unknown worker outcome must retain the claim.
          if (!dispatching && !(await releaseClaim())) {
            return;
          }
          respond(false, undefined, finalizeResult.error);
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
      } finally {
        mutation.release();
      }
    },
  ),

  "session.typing": async ({
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
    const binding = captureIncognitoSessionBinding({
      sessionKey: query.key,
      agentId: query.agentId,
    });
    const actorFacts = binding && captureIncognitoSessionMutationFacts(binding, query.key, true);
    if (!binding) {
      while (projection.needsMembershipPreparation()) {
        await projection.prepareMembership();
      }
    }
    const readTarget = (read?: Pick<SessionRowReadView, "describe">) =>
      readCollaborationTarget(projection, query, read, actorFacts);
    const incognitoError = authorizeIncognitoSessionTarget({
      client,
      sessionKey: query.key,
      target: null,
    });
    if (incognitoError) {
      respond(false, undefined, incognitoError);
      return;
    }
    const target =
      isIncognitoSessionKey(query.key) && !binding
        ? await withReadySessionRows(projection, () => [query], readTarget)
        : readTarget();
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
  },
};
