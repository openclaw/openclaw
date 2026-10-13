import {
  ErrorCodes,
  type GatewayCoreRequestParams,
  errorShape,
  validateSessionGitHubPublishParams,
  validateSessionGitHubOptionsParams,
  validateSessionGitHubStatusParams,
  validateSessionGitHubConfirmParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionGitHubOptionsResult } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { raceWithTimeout } from "../../../packages/retry/src/index.js";
import { GitHubIdentityError } from "../../agents/github-read-identity.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { OpenClawStateLeaseAcquisitionError } from "../../state/openclaw-state-lease-error.js";
import { prepareControlUiSessionPrRead } from "../control-ui-session-pr-read.js";
import {
  prepareCurrentGitHubPublicationOptionsIdentity,
  hasSupportedGitHubPublicationTarget,
  readGitHubPublicationSession,
  type PublicationSessionIdentity,
} from "../github-publication-availability.js";
import { GitHubPublicationKnownFailure } from "../github-publication-failure.js";
import { isGitHubPublicationSuperseded } from "../github-publication-relevance.js";
import { prepareGitHubPublicationRequesterV2 } from "../github-publication-requester.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { SessionWorkspaceReservationBusyError } from "../worker-environments/placement-workspace-reservation.kernel.js";
import {
  prepareGitHubPublicationOptionsRead,
  preparePersonalGitHubSessionActionV2,
} from "./github-personal-authorization.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type SessionGitHubMethod = Extract<keyof GatewayCoreRequestParams, `sessions.github.${string}`>;
const GITHUB_OPTIONS_TIMEOUT_MS = 5_000;
class GitHubOptionsTimeoutError extends Error {
  constructor() {
    super("GitHub publication options timed out after 5 seconds; retry the request.");
  }
}
const sessionGitHubFailureMessages = {
  "sessions.github.publish": "GitHub publication request failed",
  "sessions.github.options": "GitHub publication options are unavailable.",
  "sessions.github.status": "GitHub publication status is unavailable.",
  "sessions.github.confirm": "GitHub publication confirmation failed.",
};

function publicationStateUnavailableError() {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    "GitHub publication state is unavailable; retry after Gateway startup.",
  );
}

function defineSessionGitHubMethod<Method extends SessionGitHubMethod>(
  ...[method, validate, handler]: Parameters<typeof defineValidatedGatewayMethod<Method>>
) {
  return defineValidatedGatewayMethod(method, validate, async (options) => {
    const { agentId, sessionKey } = options.params;
    const key = sessionKey ?? getGatewayToolCallerIdentity()?.sessionKey;
    // Explicit public owners follow request admission, not private deleted-session remapping.
    if (agentId !== undefined && key) {
      const owner = resolveRequestedSessionAgentId(
        options.context.getRuntimeConfig(),
        key,
        agentId,
      );
      if (!owner.ok) {
        options.respond(false, undefined, owner.error);
        return;
      }
    }
    try {
      return await handler(options);
    } catch (error) {
      const publishing = method === "sessions.github.publish";
      if (publishing && error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      const acquisition =
        error instanceof OpenClawStateLeaseAcquisitionError ? error.outcome : undefined;
      const busy = error instanceof SessionWorkspaceReservationBusyError;
      const timedOut = error instanceof GitHubOptionsTimeoutError;
      const forbidden = acquisition
        ? acquisition.kind === "held"
        : !publishing && !busy && !timedOut;
      options.respond(
        false,
        undefined,
        errorShape(
          forbidden ? ErrorCodes.FORBIDDEN : ErrorCodes.UNAVAILABLE,
          error instanceof Error ? error.message : sessionGitHubFailureMessages[method],
          acquisition
            ? {
                retryable: acquisition.kind === "store-unavailable",
                details: { leaseAcquisition: acquisition },
              }
            : busy || timedOut
              ? { retryable: true }
              : publishing &&
                  error instanceof GitHubPublicationKnownFailure &&
                  "idempotencyKey" in options.params &&
                  error.rejection?.idempotencyKey === options.params.idempotencyKey
                ? { details: error.rejection }
                : undefined,
        ),
      );
    }
  });
}

async function isSessionPublicationSuperseded(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context">,
  session: PublicationSessionIdentity,
  snapshot: Parameters<typeof isGitHubPublicationSuperseded>[0],
  assertCurrent: () => void,
): Promise<boolean> {
  const { client, context } = options;
  const prOwner = context.controlUiSessionPullRequests;
  if (!client || !prOwner) {
    return false;
  }
  const readTarget = await prepareControlUiSessionPrRead({
    client,
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    getRuntimeConfig: context.getRuntimeConfig,
    getSessionRowProjection: () => getSessionRowProjection(context),
    isCurrentClient: () => {
      assertCurrent();
      return true;
    },
  });
  assertCurrent();
  const target = await readTarget?.();
  assertCurrent();
  if (!target) {
    return false;
  }
  const assertReadCurrent = () => {
    assertCurrent();
    target.assertCurrent?.();
  };
  const published = await prOwner.read(target, assertReadCurrent, "publication");
  assertReadCurrent();
  return published.status === "ready" && !published.rateLimited
    ? isGitHubPublicationSuperseded(snapshot, published.pullRequests, {
        assertCurrent: assertReadCurrent,
      })
    : false;
}

export const sessionsGitHubHandlers: GatewayRequestHandlers = {
  "sessions.github.publish": defineSessionGitHubMethod(
    "sessions.github.publish",
    validateSessionGitHubPublishParams,
    async (options) => {
      const { params, respond, context, sessionMutationAuthorization } = options;

      const coordinator = context.githubPublicationService;
      if (!coordinator) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "GitHub publication is unavailable on this Gateway"),
        );
        return;
      }
      const caller = getGatewayToolCallerIdentity();
      const sessionKey = caller?.sessionKey ?? params.sessionKey;
      if (
        !sessionKey ||
        (caller && params.sessionKey && params.sessionKey !== caller.sessionKey) ||
        (caller &&
          params.agentId &&
          normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId))
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "GitHub publication session is invalid"),
        );
        return;
      }
      const agentId = caller?.agentId ?? params.agentId;
      if (params.selection?.source === "personal") {
        if (!params.sessionKey) {
          throw new Error("My GitHub publication requires an explicit session.");
        }
        const admitted = await preparePersonalGitHubSessionActionV2(options, {
          sessionKey: params.sessionKey,
          agentId,
        });
        using _ = { [Symbol.dispose]: () => admitted.release() };

        const result = await coordinator.requestPersonalForSessionV2(params, admitted.action);
        admitted.action.assertCurrent();
        respond(true, result);

        return;
      }
      const loaded = readGitHubPublicationSession(sessionKey, agentId ? { agentId } : undefined);
      if (!loaded.entry?.sessionId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "GitHub publication session was not found"),
        );
        return;
      }
      sessionMutationAuthorization?.assertCurrent();
      const session = {
        sessionKey: loaded.canonicalKey,
        agentId: caller?.agentId ?? loaded.agentId,
      };
      const admitted = await prepareGitHubPublicationRequesterV2(options, session);
      using _ = { [Symbol.dispose]: () => admitted.release() };

      const result = await coordinator.requestForSessionV2({
        ...params,
        ...session,
        requester: admitted.requester,
        ...(caller?.operationalRunInstance?.runId
          ? { expectedRunId: caller.operationalRunInstance.runId }
          : {}),
      });
      sessionMutationAuthorization?.assertCurrent();
      respond(true, result);
    },
  ),
  "sessions.github.options": defineSessionGitHubMethod(
    "sessions.github.options",
    validateSessionGitHubOptionsParams,
    async (options) => {
      const deadline = new AbortController();
      await raceWithTimeout(
        async () => {
          using read = await prepareGitHubPublicationOptionsRead(
            options,
            options.params,
            deadline.signal,
          );

          const coordinator = options.context.githubPublicationService;
          if (!coordinator) {
            options.respond(false, undefined, publicationStateUnavailableError());
            return;
          }
          const service = options.context.githubOAuthService?.personal;
          if (read.personal.kind === "eligible" && !service) {
            throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
          }
          const action = read.personal.kind === "eligible" ? read.personal.action : null;
          const session = read.currentSession();
          const assertResponseCurrent = () => read.assertSessionUnchanged(session);
          let sharedUnavailableReason: SessionGitHubOptionsResult["sharedUnavailableReason"];
          // Independent account and receipt owners can read concurrently. The response
          // still revalidates the same session and personal authority after all awaits.
          const [identity, personalSnapshot, pendingPersonal, latestShared] = await Promise.all([
            prepareCurrentGitHubPublicationOptionsIdentity(
              read.session.agentId,
              assertResponseCurrent,
            ).catch((error: unknown) => {
              sharedUnavailableReason =
                error instanceof GitHubIdentityError ? error.reason : "unverified";
              return null;
            }),
            action ? service!.status(action) : null,
            action ? coordinator.personalPending(action, session) : null,
            coordinator.latestShared(session, options.params.idempotencyKey, (snapshot) =>
              isSessionPublicationSuperseded(options, session, snapshot, assertResponseCurrent),
            ),
          ]);
          let shared: SessionGitHubOptionsResult["shared"] = identity
            ? {
                source: identity.source,
                accountId: identity.account.accountId,
                login: identity.account.login,
              }
            : null;
          if (shared && read.sessionScoped) {
            if (!(await hasSupportedGitHubPublicationTarget(session, assertResponseCurrent))) {
              shared = null;
              sharedUnavailableReason = "unsupported_workspace";
            }
          }
          assertResponseCurrent();
          const personal =
            action && personalSnapshot
              ? service!.revalidateStatus(action, personalSnapshot)
              : personalSnapshot;
          options.respond(true, {
            personal,
            shared,
            ...(identity?.stale || personal?.stale ? { stale: true } : {}),
            ...(sharedUnavailableReason ? { sharedUnavailableReason } : {}),
            pendingPersonal,
            latestShared,
          });
        },
        GITHUB_OPTIONS_TIMEOUT_MS,
        () => {
          const error = new GitHubOptionsTimeoutError();
          // Revoke this read only; OAuth owns and settles any token rotation already started.
          deadline.abort(error);
          throw error;
        },
        { ref: false },
      );
    },
  ),
  "sessions.github.status": defineSessionGitHubMethod(
    "sessions.github.status",
    validateSessionGitHubStatusParams,
    async (options) => {
      using read = await prepareGitHubPublicationOptionsRead(options, options.params);

      const service = options.context.githubPublicationService;
      if (!service) {
        options.respond(false, undefined, publicationStateUnavailableError());
        return;
      }
      const prepared =
        read.personal.kind === "eligible"
          ? await service.preparePersonalStatus(options.params.requestId)
          : undefined;
      using _ = { [Symbol.dispose]: () => prepared?.release() };

      const session = read.currentSession();
      const shared = await service.sharedStatus(session, options.params.requestId);
      if (shared) {
        read.assertSessionUnchanged(session);
        options.respond(true, shared);
        return;
      }
      if (read.personal.kind !== "eligible") {
        throw new Error("GitHub publication was not found for this session and caller.");
      }
      const result = await service.personalStatusAsync(
        read.personal.action,
        session,
        options.params.requestId,
        prepared,
      );
      read.assertSessionUnchanged(session);
      options.respond(true, result);
    },
  ),
  "sessions.github.confirm": defineSessionGitHubMethod(
    "sessions.github.confirm",
    validateSessionGitHubConfirmParams,
    async (options) => {
      const service = options.context.githubPublicationService;
      if (!service) {
        throw new Error("GitHub publication is unavailable.");
      }
      const admitted = await preparePersonalGitHubSessionActionV2(options, options.params);
      using _ = { [Symbol.dispose]: () => admitted.release() };

      const result = await service.confirmPersonalV2(options.params, admitted.action);
      admitted.action.assertCurrent();
      options.respond(true, result);
    },
  ),
};
