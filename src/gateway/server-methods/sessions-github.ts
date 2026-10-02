import {
  ErrorCodes,
  type GatewayCoreRequestParams,
  errorShape,
  validateSessionGitHubPublishParams,
  validateSessionGitHubRequestReviewParams,
  validateSessionGitHubReviewParams,
  validateSessionGitHubOptionsParams,
  validateSessionGitHubStatusParams,
  validateSessionGitHubConfirmParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { isIncognitoSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import { OpenClawStateLeaseAcquisitionError } from "../../state/openclaw-state-lease-error.js";
import { prepareControlUiSessionPrRead } from "../control-ui-session-pr-read.js";
import {
  bindPersonalGitHubPublicationSelection,
  preparePersonalGitHubPublicationSelection,
} from "../github-personal-publication.js";
import {
  prepareCurrentGitHubPublicationOptionsIdentity,
  prepareCurrentGitHubPublicationIdentity,
  assertExpectedSharedGitHubPublisher,
  hasSupportedGitHubPublicationTarget,
  type PublicationSessionIdentity,
} from "../github-publication-availability.js";
import { GitHubPublicationKnownFailure } from "../github-publication-failure.js";
import { isGitHubPublicationSuperseded } from "../github-publication-relevance.js";
import { captureGitHubPublicationRequester } from "../github-publication-requester.js";
import { assertDurableGitHubPublicationReview } from "../github-publication-review-contract.js";
import {
  insertGitHubPublicationReview,
  listGitHubPublicationReviews,
  readGitHubPublicationReview,
} from "../github-publication-review-store.js";
import {
  assertGitHubPublicationReviewSession,
  prepareGitHubPublicationReviewConfirmation,
  projectGitHubPublicationReview,
  readGitHubPublicationReviewDiff,
  requireGitHubPublicationReview,
} from "../github-publication-review.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicy,
} from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { SessionWorkspaceReservationBusyError } from "../worker-environments/placement-workspace-reservation.js";
import {
  prepareGitHubPublicationOptionsRead,
  preparePersonalGitHubSessionAction,
} from "./github-personal-authorization.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type SessionGitHubMethod = Extract<keyof GatewayCoreRequestParams, `sessions.github.${string}`>;
const sessionGitHubFailureMessages = {
  "sessions.github.publish": "GitHub publication request failed",
  "sessions.github.requestReview": "GitHub review request failed.",
  "sessions.github.review": "GitHub publication review is unavailable.",
  "sessions.github.options": "GitHub publication options are unavailable.",
  "sessions.github.status": "GitHub publication status is unavailable.",
  "sessions.github.confirm": "GitHub publication confirmation failed.",
};

function defineSessionGitHubMethod<Method extends SessionGitHubMethod>(
  ...[method, validate, handler]: Parameters<typeof defineValidatedGatewayMethod<Method>>
) {
  return defineValidatedGatewayMethod(method, validate, async (options) => {
    const { agentId, sessionKey } = options.params;
    const caller = getGatewayToolCallerIdentity();
    const key = sessionKey ?? caller?.sessionKey;
    if (
      caller &&
      ((sessionKey && sessionKey !== caller.sessionKey) ||
        (agentId && normalizeAgentId(agentId) !== normalizeAgentId(caller.agentId)))
    ) {
      options.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "GitHub publication requires the current session."),
      );
      return;
    }
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
      const forbidden = acquisition ? acquisition.kind === "held" : !publishing && !busy;
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
            : busy
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
      const loaded = loadGatewaySessionEntryReadOnly(sessionKey, agentId ? { agentId } : undefined);
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
      const admitted = await captureGitHubPublicationRequester(options, session);
      try {
        const review = params.review
          ? await prepareGitHubPublicationReviewConfirmation(
              params.review,
              {
                ...session,
                sessionId: loaded.entry.sessionId,
                lifecycleRevision: loaded.entry.lifecycleRevision ?? null,
              },
              admitted.requester,
            )
          : undefined;
        requireGitHubPublicationReview({
          sandbox: loaded.entry.sandbox,
          requester: admitted.requester,
          review,
        });
        const request = review
          ? {
              ...params,
              idempotencyKey: `review:${review.id}`,
              title: review.candidate.title ?? undefined,
              body: review.candidate.body ?? undefined,
              selection: review.candidate.selection,
            }
          : params;
        if (request.selection?.source === "personal") {
          const action = preparePersonalGitHubSessionAction(options, { sessionKey, agentId });
          const result = await coordinator.requestPersonalForSession(request, action, review);
          action.assertCurrent();
          respond(true, result);
          return;
        }
        const result = await coordinator.requestForSession({
          ...request,
          ...session,
          preparedReview: review,
          requester: admitted.requester,
          ...(caller?.operationalRunInstance?.runId
            ? { expectedRunId: caller.operationalRunInstance.runId }
            : {}),
        });
        sessionMutationAuthorization?.assertCurrent();
        respond(true, result);
      } finally {
        admitted.release();
      }
    },
  ),
  "sessions.github.requestReview": defineSessionGitHubMethod(
    "sessions.github.requestReview",
    validateSessionGitHubRequestReviewParams,
    async (options) => {
      assertDurableGitHubPublicationReview(options.params.sessionKey);
      if (!options.context.githubPublicationService) {
        throw new Error("GitHub publication is unavailable.");
      }
      const read = await prepareGitHubPublicationOptionsRead(options, options.params);
      if (
        !(await hasSupportedGitHubPublicationTarget(read.currentSession(), read.currentSession))
      ) {
        throw new Error("Review requires this conversation's managed GitHub repository workspace.");
      }
      read.currentSession();
      const actor = resolveGatewayOperatorRoleActor(options.client);
      const profileId =
        actor?.kind === "operator"
          ? actor.profileId
          : actor?.kind === "system"
            ? GATEWAY_OWNER_PROFILE_ID
            : undefined;
      if (!profileId) {
        throw new Error("Request review from an authenticated profile.");
      }
      const row = await insertGitHubPublicationReview({
        session: read.currentSession(),
        idempotencyKey: options.params.idempotencyKey,
        profileId,
        assertCurrent: () => {
          read.currentSession();
          options.sessionMutationAuthorization?.assertCurrent();
        },
      });
      options.respond(true, projectGitHubPublicationReview(row));
    },
  ),
  "sessions.github.review": defineSessionGitHubMethod(
    "sessions.github.review",
    validateSessionGitHubReviewParams,
    async (options) => {
      const read = await prepareGitHubPublicationOptionsRead(options, options.params);
      const service = options.context.githubPublicationService;
      if (!service) {
        throw new Error("GitHub publication is unavailable.");
      }
      const request = options.params;
      if (request.action === "diff") {
        const row = await readGitHubPublicationReview({ reviewId: request.reviewId });
        if (!row) {
          throw new Error("The review candidate is unavailable.");
        }
        assertGitHubPublicationReviewSession(row, read.currentSession());
        const result = readGitHubPublicationReviewDiff(row, request, request.offset);
        read.currentSession();
        options.respond(true, result);
        return;
      }
      const session = read.currentSession();
      const admitted = await captureGitHubPublicationRequester(options, session);
      try {
        const personal =
          request.selection?.source === "personal"
            ? bindPersonalGitHubPublicationSelection(
                preparePersonalGitHubSessionAction(options, session),
                request.selection,
              )
            : undefined;
        const row = await service.prepareReview({
          session,
          request,
          requester: admitted.requester,
          expectedRunId: getGatewayToolCallerIdentity()?.operationalRunInstance?.runId,
          signal: options.signal ?? new AbortController().signal,
          prepareIdentity: async (assertCurrent) => {
            const identity = personal
              ? await preparePersonalGitHubPublicationSelection(personal, assertCurrent)
              : await prepareCurrentGitHubPublicationIdentity(session.agentId);
            assertCurrent();
            if (request.selection?.source === "shared") {
              assertExpectedSharedGitHubPublisher(request.selection.expected, {
                source: identity.source,
                ...identity.account,
              });
            }
            return identity;
          },
        });
        admitted.requester.assertCurrent();
        options.respond(true, projectGitHubPublicationReview(row));
      } finally {
        admitted.release();
      }
    },
  ),
  "sessions.github.options": defineSessionGitHubMethod(
    "sessions.github.options",
    validateSessionGitHubOptionsParams,
    async (options) => {
      const read = await prepareGitHubPublicationOptionsRead(options, options.params);
      const coordinator = options.context.githubPublicationService;
      if (!coordinator) {
        options.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "GitHub publication state is unavailable; retry after Gateway startup.",
          ),
        );
        return;
      }
      let shared = null;
      try {
        const identity = await prepareCurrentGitHubPublicationOptionsIdentity(read.session.agentId);
        shared = {
          source: identity.source,
          accountId: identity.account.accountId,
          login: identity.account.login,
        };
      } catch {
        /* An unavailable shared account must not hide the caller's personal option. */
      }
      read.currentSession();
      const service = options.context.githubOAuthService?.personal;
      if (read.personal.kind === "eligible" && !service) {
        throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
      }
      const action = read.personal.kind === "eligible" ? read.personal.action : null;
      let personal = action ? await service!.status(action) : null;
      const session = read.currentSession();
      const pendingPersonal = action ? await coordinator.personalPending(action, session) : null;
      read.currentSession();
      if (action && personal) {
        personal = service!.revalidateStatus(action, personal);
      }
      const latestShared = await coordinator.latestShared(
        session,
        options.params.idempotencyKey,
        (snapshot) =>
          isSessionPublicationSuperseded(options, session, snapshot, read.currentSession),
      );
      read.currentSession();
      if (action && personal) {
        personal = service!.revalidateStatus(action, personal);
      }
      const reviewAvailable =
        !isIncognitoSessionKey(session.sessionKey) &&
        (await hasSupportedGitHubPublicationTarget(session, read.currentSession));
      read.currentSession();
      if (shared && read.sessionScoped && !reviewAvailable) {
        shared = null;
      }
      const rows = await listGitHubPublicationReviews(session);
      const reviews = rows
        .filter(
          (row) =>
            row.candidate_json ||
            !rows.some((candidate) => candidate.requested_review_id === row.review_id),
        )
        .map((row) => projectGitHubPublicationReview(row, coordinator.reviewResult(row)));
      read.currentSession();
      const loaded = loadGatewaySessionEntryReadOnly(session.sessionKey, {
        agentId: session.agentId,
      });
      const role = resolveOperatorRolePolicy(options.client, options.context.getRuntimeConfig());
      options.respond(true, {
        personal,
        shared,
        pendingPersonal,
        latestShared,
        reviews,
        reviewAvailable,
        reviewRequired:
          loaded.entry?.sandbox === "required" ||
          role?.sandbox === "required" ||
          role?.execution === "foreground-only",
      });
    },
  ),
  "sessions.github.status": defineSessionGitHubMethod(
    "sessions.github.status",
    validateSessionGitHubStatusParams,
    async (options) => {
      const read = await prepareGitHubPublicationOptionsRead(options, options.params);
      const service = options.context.githubPublicationService;
      if (!service) {
        options.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "GitHub publication state is unavailable; retry after Gateway startup.",
          ),
        );
        return;
      }
      const prepared =
        read.personal.kind === "eligible"
          ? await service.preparePersonalStatus(options.params.requestId)
          : undefined;
      const session = read.currentSession();
      const shared = await service.sharedStatus(session, options.params.requestId);
      if (shared) {
        read.currentSession();
        options.respond(true, shared);
        return;
      }
      if (read.personal.kind !== "eligible") {
        throw new Error("GitHub publication was not found for this session and caller.");
      }
      const result = service.personalStatus(
        read.personal.action,
        session,
        options.params.requestId,
        prepared,
      );
      read.currentSession();
      options.respond(true, result);
    },
  ),
  "sessions.github.confirm": defineSessionGitHubMethod(
    "sessions.github.confirm",
    validateSessionGitHubConfirmParams,
    async (options) => {
      const action = preparePersonalGitHubSessionAction(options, options.params);
      const service = options.context.githubPublicationService;
      if (!service) {
        throw new Error("GitHub publication is unavailable.");
      }
      const admitted = await captureGitHubPublicationRequester(options, action);
      try {
        const review = options.params.review
          ? await prepareGitHubPublicationReviewConfirmation(
              options.params.review,
              action,
              admitted.requester,
            )
          : undefined;
        requireGitHubPublicationReview({
          sandbox: loadGatewaySessionEntryReadOnly(action.sessionKey, { agentId: action.agentId })
            .entry?.sandbox,
          requester: admitted.requester,
          review,
        });
        const result = await service.confirmPersonal(options.params, action, review);
        action.assertCurrent();
        options.respond(true, result);
      } finally {
        admitted.release();
      }
    },
  ),
};
