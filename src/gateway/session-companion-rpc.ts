import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
  validateSessionsCompanionAskParams,
  validateSessionsCompanionResetParams,
  validateSessionsCompanionStateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { assertOperatorModelAllowed } from "../agents/admitted-run-context.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  releaseSessionSourceAuthorities,
  type SessionSourceAssertion,
  type PreparedSessionSourceAuthority,
} from "../config/sessions/session-source-authority.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { defineValidatedGatewayHandler } from "./server-methods/validation.js";
import { SessionCompanionAskError } from "./session-companion-errors.js";
import { resolveSessionCompanionAskSelection } from "./session-companion-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { captureSessionSharingMemoryFacts } from "./session-sharing-incognito.js";
import {
  hiddenSessionNotFound,
  type PreparedSessionMutationFacts,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";
import {
  prepareProjectedSessionSharing,
  prepareSessionSharingProfiles,
  type PreparedSessionSharingProfiles,
} from "./session-sharing-read.js";
import { prepareSessionSharingSource } from "./session-sharing-source.js";
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
  client: Parameters<GatewayRequestHandlers[string]>[0]["client"],
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  prepared: {
    target: Pick<SessionSharingTarget, "storeKey" | "entry"> | null;
    membership: ReadonlySet<string>;
    profiles?: PreparedSessionSharingProfiles;
  },
): boolean {
  if (client?.connId && context.isConnectionActive?.(client.connId) === false) {
    return false;
  }
  const cfg = context.getRuntimeConfig();
  const sharingTarget = prepared.target;
  if (!sharingTarget) {
    return cfg.gateway?.roles === undefined;
  }
  const sharing = prepareProjectedSessionSharing({
    client,
    cfg,
    profiles: prepared.profiles,
    isMember: (_target, id) => prepared.membership.has(id),
  });
  return sharing.entryFilter?.(sharingTarget.storeKey, sharingTarget.entry) !== false;
}

export const sessionCompanionHandlers: GatewayRequestHandlers = {
  "sessions.companion.ask": defineValidatedGatewayHandler(
    "sessions.companion.ask",
    validateSessionsCompanionAskParams,
    async ({ params, respond, client, context, signal, hasCurrentClientAuthority }) => {
      const { sessionKey, agentId, question, selectionContext, attachments, model } = params;
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
      const resolvedSelection = await resolveSessionCompanionAskSelection({
        cfg: sourceCfg,
        agentId: target.agentId,
        model,
        thinkingLevel: params.thinkingLevel,
        fastMode: params.fastMode,
        loadModelCatalog: () => context.loadGatewayModelCatalog({ agentId: target.agentId }),
      });
      if (!resolvedSelection.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, resolvedSelection.error));
        return;
      }
      const selection = resolvedSelection.selection;
      const sourceTargetScope = {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
      };
      const companion = target.companion;
      const connId = client.connId;
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
      const actorFacts = captureSessionSharingMemoryFacts(
        {
          ...sourceTargetScope,
          resolved: {
            storePath: resolveSessionStorePathCore(sourceCfg.session?.store, {
              agentId: target.agentId,
            }),
          },
        },
        assertLifetimeCurrent,
      );
      let releaseSharing: (() => void) | undefined;
      let capturedOperator:
        | Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>
        | undefined;
      let retainedSource: PreparedSessionSourceAuthority | undefined;
      try {
        const profiles = await prepareSessionSharingProfiles(client);
        let readSharingFacts: () => PreparedSessionMutationFacts;
        if (actorFacts) {
          readSharingFacts = actorFacts.readCurrent;
        } else {
          const preparedFacts = await prepareSessionMutationFacts({
            cfg: sourceCfg,
            ...sourceTargetScope,
            allowMissing: true,
          });
          releaseSharing = preparedFacts.release;
          readSharingFacts = () => preparedFacts.readCurrent(context.getRuntimeConfig());
        }
        const initialSharingFacts = readSharingFacts();
        const initialSharingTarget = initialSharingFacts.target;
        if (!companionTargetIsVisible(client, context, { ...initialSharingFacts, profiles })) {
          respond(false, undefined, hiddenSessionNotFound(target.sessionKey));
          return;
        }
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
        const refuseSource = (): never => {
          throw new SessionCompanionAskError("session-missing", "Side chat is unavailable.");
        };
        const assertSourceCurrent: SessionSourceAssertion = Object.assign(
          () => {
            assertLifetimeCurrent();
            if (!companionTargetIsVisible(client, context, { ...readSharingFacts(), profiles })) {
              refuseSource();
            }
          },
          {
            async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
              assertLifetimeCurrent();
              const read = await prepareSessionSharingSource(
                sourceTarget,
                assertLifetimeCurrent,
                actorFacts,
              );
              const assertCurrent = () => {
                assertSourceCurrent();
                read.assertCurrent();
                const cfg = context.getRuntimeConfig();
                if (
                  cfg.session?.store !== sourceStore ||
                  cfg.session?.mainKey !== sourceMainKey ||
                  cfg.session?.scope !== sourceScope
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
                checks: read.actorSource
                  ? []
                  : [
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
        assertInputCurrent?.();
        if (actorFacts) {
          retainedSource = await assertSourceCurrent.prepareSessionSource?.();
          retainedSource?.assertCurrent();
        }
        capturedOperator = await captureGatewayOperatorRunAuthority({
          client,
          context,
          hasCurrentClientAuthority,
          invocationAuthority: { assertCurrent: assertSourceCurrent, signal },
        });
        assertSourceCurrent();
        assertInputCurrent?.();
        if (selection?.model && capturedOperator) {
          // A chosen model is refused, never swapped for the role's permitted default.
          try {
            assertOperatorModelAllowed(capturedOperator.authority, selection.model);
          } catch (error) {
            if (error instanceof SessionMutationAuthorizationChangedError) {
              throw error;
            }
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.FORBIDDEN,
                error instanceof Error ? error.message : "Side chat cannot use this model.",
              ),
            );
            return;
          }
        }
        const result = await companion.ask({
          sessionKey: target.sessionKey,
          agentId: target.agentId,
          question,
          ...(selectionContext ? { selectionContext } : {}),
          ...(originalAttachments ? { attachments: originalAttachments } : {}),
          ...(selection ? { selection } : {}),
          connId,
          assertSourceCurrent,
          ...(assertInputCurrent ? { assertInputCurrent } : {}),
          ...(capturedOperator ? { operatorAuthority: capturedOperator.authority } : {}),
          ...(signal ? { signal } : {}),
        });
        retainedSource?.assertCurrent();
        assertSourceCurrent();
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
        try {
          capturedOperator?.release();
          await retainedSource?.release?.();
        } finally {
          releaseSharing?.();
        }
      }
    },
  ),
  "sessions.companion.state": defineValidatedGatewayHandler(
    "sessions.companion.state",
    validateSessionsCompanionStateParams,
    async ({ params, respond, client, context }) => {
      const { sessionKey, agentId } = params;
      const target = resolveCompanionTarget({ sessionKey, agentId }, context);
      if (!target.ok) {
        respond(false, undefined, target.error);
        return;
      }
      const profiles = await prepareSessionSharingProfiles(client);
      const facts = await prepareSessionMutationFacts({
        cfg: context.getRuntimeConfig(),
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        allowMissing: true,
      });
      try {
        if (
          !companionTargetIsVisible(client, context, {
            ...facts.readCurrent(context.getRuntimeConfig()),
            profiles,
          })
        ) {
          respond(false, undefined, hiddenSessionNotFound(target.sessionKey));
          return;
        }
        respond(
          true,
          target.companion.state({ agentId: target.agentId, sessionKey: target.sessionKey }),
        );
      } finally {
        facts.release();
      }
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
