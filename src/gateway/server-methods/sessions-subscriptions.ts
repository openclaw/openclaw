import {
  ErrorCodes,
  errorShape,
  validateSessionsMessagesSubscribeParams,
  validateSessionsMessagesUnsubscribeParams,
  validateSessionsSubscribeParams,
  validateSessionsViewerPresenceSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { canReviewOperatorApproval } from "../operator-approval-authorization.js";
import { APPROVALS_SCOPE } from "../operator-scopes.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { resolveRequestedSessionStoreTarget } from "../session-store-key.js";
import { resolveSessionSubscriptionKey } from "../session-subscription-keys.js";
import { prepareApprovalSessionAccess } from "./approval-record-lookup.js";
import { respondError } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import { sessionsListHandler } from "./sessions-read.js";
import { requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers, PreparedSessionApprovalReplay, RespondFn } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler } from "./validation.js";

export const sessionSubscriptionHandlers: GatewayRequestHandlers = {
  "sessions.subscribe": async (options) => {
    const { client, context, params, respond } = options;
    if (
      !assertValidParams(params, validateSessionsSubscribeParams, "sessions.subscribe", respond)
    ) {
      return;
    }
    const { includeMessageBodies, ...listParams } = params;
    const connId = client?.connId?.trim();
    if (client && connId) {
      if (includeMessageBodies !== undefined) {
        client.includeSessionMessageBodies = includeMessageBodies;
      }
      // Subscribe before projecting the snapshot so mutations during the read
      // become live events; the UI queues one trailing refresh when needed.
      context.subscribeSessionEvents(connId);
    }
    if (!connId || Object.keys(listParams).length === 0) {
      respond(true, { subscribed: Boolean(connId) }, undefined);
      return;
    }
    await sessionsListHandler({
      ...options,
      params: listParams,
      respond: (ok, payload, error, meta) => {
        respond(ok, ok ? { subscribed: true, list: payload } : undefined, error, meta);
      },
    });
  },
  "sessions.viewers.set": defineValidatedGatewayHandler(
    "sessions.viewers.set",
    validateSessionsViewerPresenceSetParams,
    ({ params, client, context, respond }) => {
      const connId = client?.connId?.trim();
      const declarations = context.sessionViewerPresence;
      if (!connId || !declarations) {
        respondError(respond, ErrorCodes.UNAVAILABLE, "session viewer presence unavailable");
        return;
      }
      const cfg = context.getRuntimeConfig();
      const canonicalKeys: string[] = [];
      for (const rawKey of params.sessionKeys) {
        const trimmed = rawKey.trim();
        if (!trimmed) {
          respondError(respond, ErrorCodes.INVALID_REQUEST, "invalid sessions.viewers.set params");
          return;
        }
        const requested = resolveRequestedSessionStoreTarget(
          cfg,
          trimmed,
          parseAgentSessionKey(trimmed) ? undefined : params.agentId,
        );
        if (!requested.ok) {
          respond(false, undefined, requested.error);
          return;
        }
        canonicalKeys.push(
          sessionObserverScopeKey(requested.value.sessionKey, requested.value.agentId),
        );
      }
      const sessionKeys = declarations.replace(connId, canonicalKeys);
      respond(true, { sessionKeys }, undefined);
    },
  ),
  "sessions.messages.subscribe": defineValidatedGatewayHandler(
    "sessions.messages.subscribe",
    validateSessionsMessagesSubscribeParams,
    async (options) => {
      const {
        params,
        client,
        context,
        respond,
        sessionMutationAuthorization,
        hasCurrentClientAuthority,
        signal,
        markSessionSubscribePhase: mark,
      } = options;

      const connId = client?.connId?.trim();
      const key = requireSessionKey(params.key, respond);
      if (!key) {
        return;
      }
      if (params.includeApprovals === true && !canReviewOperatorApproval(client)) {
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          `sessions.messages.subscribe includeApprovals requires a paired device and gateway scope: ${APPROVALS_SCOPE}`,
        );
        return;
      }
      const cfg = context.getRuntimeConfig();
      const requestedAgent = resolveRequestedSessionStoreTarget(cfg, key, params.agentId, "read");
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return;
      }
      const { agentId: requestedAgentId, sessionKey: canonicalKey } = requestedAgent.value;
      const subscriptionKey = resolveSessionSubscriptionKey(canonicalKey, requestedAgentId);
      let read: Awaited<ReturnType<typeof retainSessionScopedRead>>;
      let prepared: PreparedSessionApprovalReplay | undefined;
      try {
        mark?.("retainedReadAdmission");
        sessionMutationAuthorization?.assertCurrent();
        read = await retainSessionScopedRead(options, canonicalKey, requestedAgentId, {
          // Activity and labels may change while approvals load without revoking access.
          allowMetadataChanges: true,
          requireMaterialized:
            readGatewayRequestMutationAuthority(options).sessionScope === "operator.sessions.read",
        });
        options.sessionMutationCommitGuard?.();
        const includeApprovals = Boolean(connId) && params.includeApprovals === true;
        // Provisional observers deliver events while the snapshot is prepared, then roll back on failure.
        const rollback = connId
          ? context.subscribeSessionMessageEvents(connId, subscriptionKey, {
              ...(includeApprovals ? { includeApprovals: true } : {}),
              provisional: true,
              mode: params.mode,
              subscriptionId: params.subscriptionId,
            })
          : undefined;
        try {
          using sessionAccess = includeApprovals
            ? await prepareApprovalSessionAccess({
                client,
                getCfg: context.getRuntimeConfig,
                sources: [{ sessionKey: canonicalKey, agentId: requestedAgentId }],
              })
            : undefined;
          if (includeApprovals) {
            read?.assertCurrent();
            sessionMutationAuthorization?.assertCurrent();
            mark?.("replayPreparation");
            prepared = await context.listSessionPendingApprovals?.(subscriptionKey, client);
            if (prepared && !prepared.isCurrent()) {
              throw new Error("session approval replay changed during preparation");
            }
          }
          let initialHistory:
            | { ok: true; payload: unknown }
            | { ok: false; error: NonNullable<Parameters<RespondFn>[2]> }
            | undefined;
          if (params.initialHistory) {
            const unavailable = errorShape(
              ErrorCodes.UNAVAILABLE,
              "initial chat history unavailable",
              {
                retryable: true,
              },
            );
            initialHistory = { ok: false, error: unavailable };
            const historyParams = {
              ...params.initialHistory,
              sessionKey: canonicalKey,
              agentId: requestedAgentId,
            };
            try {
              const { handleChatHistoryRequest } = await import("./chat-history-handler.js");
              // The provisional observer covers every event after this snapshot begins.
              await handleChatHistoryRequest({
                ...options,
                method: "chat.startup",
                params: historyParams,
                req: { ...options.req, method: "chat.startup", params: historyParams },
                respond: (ok, payload, error) => {
                  initialHistory = ok
                    ? { ok: true, payload }
                    : { ok: false, error: error ?? unavailable };
                },
              });
            } catch {
              // History failure alone does not reject a still-authorized observer.
              context.logGateway.debug(
                "initial chat history read failed during subscription admission",
              );
            }
          }
          // Retain disclosure authority through history I/O and publish before releasing it.
          read?.assertCurrent();
          sessionMutationAuthorization?.assertCurrent();
          if (includeApprovals) {
            if (!prepared || !prepared.isCurrent()) {
              throw new Error("session approval replay changed during preparation");
            }
            if (
              client?.invalidated ||
              signal?.aborted ||
              hasCurrentClientAuthority?.() === false ||
              !canReviewOperatorApproval(client) ||
              !sessionAccess?.canAccess({
                sessionKey: canonicalKey,
                agentId: requestedAgentId,
              })
            ) {
              throw new Error("session approval replay authority is no longer active");
            }
          }
          mark?.("observerCommit");
          rollback?.commit();
          mark?.("response");
          respond(
            true,
            {
              subscribed: Boolean(connId),
              key: canonicalKey,
              agentId: requestedAgentId,
              ...(includeApprovals ? { approvalReplay: prepared?.replay } : {}),
              ...(initialHistory ? { initialHistory } : {}),
            },
            undefined,
          );
        } catch (error) {
          rollback?.();
          if (!includeApprovals) {
            throw error;
          }
          context.logGateway.error(`session approval replay failed: ${String(error)}`);
          respondError(respond, ErrorCodes.UNAVAILABLE, "session approval replay unavailable");
        }
      } catch (error) {
        if (!(error instanceof SessionMutationAuthorizationChangedError)) {
          throw error;
        }
        respond(false, undefined, error.error);
      } finally {
        mark?.("cleanup");
        prepared?.release();
        read?.release();
      }
    },
  ),
  "sessions.messages.unsubscribe": defineValidatedGatewayHandler(
    "sessions.messages.unsubscribe",
    validateSessionsMessagesUnsubscribeParams,
    ({ params, client, context, respond }) => {
      const connId = client?.connId?.trim();
      const key = requireSessionKey(params.key, respond);
      if (!key) {
        return;
      }
      const cfg = context.getRuntimeConfig();
      const requestedAgent = resolveRequestedSessionStoreTarget(cfg, key, params.agentId, "read");
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return;
      }
      const { agentId: requestedAgentId, sessionKey: canonicalKey } = requestedAgent.value;
      const subscriptionKey = resolveSessionSubscriptionKey(canonicalKey, requestedAgentId);
      if (connId) {
        context.unsubscribeSessionMessageEvents(connId, subscriptionKey, params.subscriptionId);
      }
      respond(true, { subscribed: false, key: canonicalKey }, undefined);
    },
  ),
};
