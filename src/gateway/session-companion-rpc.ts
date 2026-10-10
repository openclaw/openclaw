import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
  validateSessionsCompanionAskParams,
  validateSessionsCompanionResetParams,
  validateSessionsCompanionStateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  releaseSessionSourceAuthorities,
  type SessionSourceAssertion,
  type PreparedSessionSourceAuthority,
} from "../config/sessions/session-source-authority.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { defineValidatedGatewayHandler } from "./server-methods/validation.js";
import { SessionCompanionAskError } from "./session-companion-errors.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { hiddenSessionNotFound } from "./session-sharing-policy.js";
import { prepareSessionSharingSource } from "./session-sharing-source.js";
import { prepareSessionSharing, resolveSessionSharingTarget } from "./session-sharing.js";
import { resolveRequestedSessionStoreTarget } from "./session-store-key.js";
import { captureGatewayClientUploadCommitGuard } from "./upload-policy.js";

function resolveCompanionTarget(
  params: { sessionKey: string; agentId?: string | undefined },
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
) {
  const companion = context.sessionCompanion;
  if (!companion) {
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.UNAVAILABLE, "Side chat is unavailable."),
    };
  }
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedSessionStoreTarget(cfg, params.sessionKey, params.agentId);
  if (!requested.ok) {
    return requested;
  }
  return {
    ok: true as const,
    companion,
    ...requested.value,
  };
}

function companionTargetIsVisible(
  target: { sessionKey: string; agentId: string },
  client: Parameters<GatewayRequestHandlers[string]>[0]["client"],
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  prepared?: { target: ReturnType<typeof resolveSessionSharingTarget> },
): boolean {
  if (client?.connId && context.isConnectionActive?.(client.connId) === false) {
    return false;
  }
  const cfg = context.getRuntimeConfig();
  const sharingTarget = prepared
    ? prepared.target
    : resolveSessionSharingTarget({
        cfg,
        sessionKey: target.sessionKey,
        agentId: target.agentId,
      });
  if (!sharingTarget) {
    return cfg.gateway?.roles === undefined;
  }
  return (
    prepareSessionSharing({ client, cfg }).entryFilter?.(
      sharingTarget.storeKey,
      sharingTarget.entry,
    ) !== false
  );
}

export const sessionCompanionHandlers: GatewayRequestHandlers = {
  "sessions.companion.ask": defineValidatedGatewayHandler(
    "sessions.companion.ask",
    validateSessionsCompanionAskParams,
    async ({ params, respond, client, context, signal, hasCurrentClientAuthority }) => {
      const { sessionKey, agentId, question, selectionContext, attachments } = params;
      if (!question.trim()) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "question must contain non-whitespace text"),
        );
        return;
      }
      if (!client?.connId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.FORBIDDEN, "Side chat questions require a connected client."),
        );
        return;
      }
      const target = resolveCompanionTarget({ sessionKey, agentId }, context);
      if (!target.ok) {
        respond(false, undefined, target.error);
        return;
      }
      const sourceCfg = context.getRuntimeConfig();
      const initialSharingTarget = resolveSessionSharingTarget({
        cfg: sourceCfg,
        sessionKey: target.sessionKey,
        agentId: target.agentId,
      });
      if (!companionTargetIsVisible(target, client, context, { target: initialSharingTarget })) {
        respond(false, undefined, hiddenSessionNotFound(target.sessionKey));
        return;
      }
      const companion = target.companion;
      const connId = client.connId;
      const originalAttachments = attachments?.length ? structuredClone(attachments) : undefined;
      const assertInputCurrent = captureGatewayClientUploadCommitGuard({
        method: "sessions.companion.ask",
        requestParams: { attachments: originalAttachments },
        client,
        context,
      });
      const sourceTarget = initialSharingTarget ?? {
        agentId: target.agentId,
        canonicalKey: target.sessionKey,
        storeKey: target.sessionKey,
        storePath: resolveSessionStorePathCore(sourceCfg.session?.store, {
          agentId: target.agentId,
        }),
      };
      const sourceStore = sourceCfg.session?.store;
      const sourceMainKey = sourceCfg.session?.mainKey;
      const sourceScope = sourceCfg.session?.scope;
      const assertLifetimeCurrent = () => {
        signal?.throwIfAborted();
        if (
          context.sessionCompanion !== companion ||
          client.connId !== connId ||
          client.invalidated ||
          hasCurrentClientAuthority?.() === false ||
          context.isConnectionActive?.(connId) === false
        ) {
          throw new SessionCompanionAskError("session-missing", "Side chat is unavailable.");
        }
      };
      const refuseSource = (): never => {
        throw new SessionCompanionAskError("session-missing", "Side chat is unavailable.");
      };
      const assertSourceCurrent: SessionSourceAssertion = Object.assign(
        () => {
          assertLifetimeCurrent();
          if (!companionTargetIsVisible(target, client, context)) {
            refuseSource();
          }
        },
        // The source may be incognito even when Side chat's private execution is durable.
        isIncognitoSessionKey(target.sessionKey)
          ? { nativeSource: true }
          : {
              async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
                assertLifetimeCurrent();
                const read = await prepareSessionSharingSource(sourceTarget, assertLifetimeCurrent);
                const assertCurrent = () => {
                  assertLifetimeCurrent();
                  read.assertCurrent();
                  const cfg = context.getRuntimeConfig();
                  if (
                    cfg.session?.store !== sourceStore ||
                    cfg.session?.mainKey !== sourceMainKey ||
                    cfg.session?.scope !== sourceScope ||
                    (read.target
                      ? prepareSessionSharing({ client, cfg }).entryFilter?.(
                          read.target.storeKey,
                          read.target.entry,
                        ) === false
                      : cfg.gateway?.roles !== undefined)
                  ) {
                    refuseSource();
                  }
                };
                try {
                  assertCurrent();
                } catch (error) {
                  await releaseSessionSourceAuthorities([read], [error]);
                  throw error;
                }
                return {
                  assertCurrent,
                  checks: [
                    {
                      predicate: {
                        source: read.source,
                        sessionKey: sourceTarget.storeKey,
                        fields: ["sessionId", "createdActor", "visibility", "incognito"],
                        expected: read.target?.entry,
                      },
                      refuse: refuseSource,
                    },
                  ],
                  release: read.release,
                };
              },
            },
      );
      let capturedOperator: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
      try {
        assertInputCurrent?.();
        capturedOperator = await captureGatewayOperatorRunAuthority({
          client,
          context,
          hasCurrentClientAuthority,
          invocationAuthority: { assertCurrent: assertSourceCurrent, signal },
        });
        assertSourceCurrent();
        assertInputCurrent?.();
        const result = await companion.ask({
          sessionKey: target.sessionKey,
          agentId: target.agentId,
          question,
          ...(selectionContext ? { selectionContext } : {}),
          ...(originalAttachments ? { attachments: originalAttachments } : {}),
          connId,
          assertSourceCurrent,
          ...(assertInputCurrent ? { assertInputCurrent } : {}),
          ...(capturedOperator ? { operatorAuthority: capturedOperator.authority } : {}),
          ...(signal ? { signal } : {}),
        });
        capturedOperator?.authority.assertCurrent();
        respond(true, result);
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          respond(false, undefined, error.error);
          return;
        }
        if (!(error instanceof SessionCompanionAskError)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "Side chat could not answer right now."),
          );
          return;
        }
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error.message,
            error.reason === "busy"
              ? {
                  details: { code: GatewayErrorDetailCodes.SESSION_COMPANION_BUSY },
                  retryable: true,
                }
              : {
                  details: { reason: error.reason },
                  retryable:
                    error.reason === "rate-limited" || error.reason === "context-unavailable",
                  ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
                },
          ),
        );
      } finally {
        capturedOperator?.release();
      }
    },
  ),
  "sessions.companion.state": defineValidatedGatewayHandler(
    "sessions.companion.state",
    validateSessionsCompanionStateParams,
    ({ params, respond, client, context }) => {
      const { sessionKey, agentId } = params;
      const target = resolveCompanionTarget({ sessionKey, agentId }, context);
      if (!target.ok) {
        respond(false, undefined, target.error);
        return;
      }
      if (!companionTargetIsVisible(target, client, context)) {
        respond(false, undefined, hiddenSessionNotFound(target.sessionKey));
        return;
      }
      respond(
        true,
        target.companion.state({
          agentId: target.agentId,
          sessionKey: target.sessionKey,
        }),
      );
    },
  ),
  "sessions.companion.reset": defineValidatedGatewayHandler(
    "sessions.companion.reset",
    validateSessionsCompanionResetParams,
    ({ params, respond, context }) => {
      const { sessionKey, agentId } = params;
      const target = resolveCompanionTarget({ sessionKey, agentId }, context);
      if (!target.ok) {
        respond(false, undefined, target.error);
        return;
      }
      target.companion.reset({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
      });
      respond(true, { ok: true });
    },
  ),
};
