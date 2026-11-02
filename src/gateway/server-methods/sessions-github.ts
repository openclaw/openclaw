import fs from "node:fs/promises";
import path from "node:path";
import {
  ErrorCodes,
  type GatewayCoreRequestParams,
  errorShape,
  validateSessionGitHubPublishParams,
  validateSessionGitHubActionParams,
  validateSessionGitHubReadinessParams,
  validateSessionGitHubOptionsParams,
  validateSessionGitHubStatusParams,
  validateSessionGitHubConfirmParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionGitHubOptionsResult } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { raceWithTimeout } from "../../../packages/retry/src/index.js";
import { GitHubIdentityError } from "../../agents/github-read-identity.js";
import { canRefreshGitHubPublicationBase } from "../../agents/sandbox/github-publication.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { githubAccountAvatarUrl } from "../../shared/github-account-avatar.js";
import { OpenClawStateLeaseAcquisitionError } from "../../state/openclaw-state-lease-error.js";
import { createControlUiSessionPrRead } from "../control-ui-session-pr-read.js";
import { performSessionGitHubPreparation } from "../github-pr-workspace-preparation.js";
import { performSessionGitHubAction } from "../github-publication-actions.js";
import {
  prepareCurrentGitHubPublicationIdentity,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationOptionsIdentity,
  qualifyGitHubPublicationSource,
  prepareGitHubPublicationSession,
} from "../github-publication-availability.js";
import { refreshManagedWorkspaceBase } from "../github-publication-base-refresh.js";
import { GitHubPublicationKnownFailure } from "../github-publication-failure.js";
import { performSessionGitHubInspection } from "../github-publication-inspect.js";
import { readGitHubPublicationReadiness } from "../github-publication-readiness.js";
import { isGitHubPublicationSuperseded } from "../github-publication-relevance.js";
import { prepareGitHubPublicationRequesterV2 } from "../github-publication-requester.js";
import type { PublicationSessionIdentity } from "../github-publication-session.types.js";
import { adoptUnboundPullRequestWorkspace } from "../session-pr-workspace-adoption.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { resolveLocalWorkspaceOwner } from "../worker-environments/local-workspace-projection.js";
import { SessionWorkspaceReservationBusyError } from "../worker-environments/placement-workspace-reservation.kernel.js";
import {
  prepareGitHubPublicationOptionsRead,
  preparePersonalGitHubSessionActionV2,
} from "./github-personal-authorization.js";
import { respondError } from "./response.js";
import { prepareSessionCreateRequestedCwd } from "./session-create-root.js";
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
  "sessions.github.action":
    "GitHub pull request action failed; inspect its current state before retrying.",
  "sessions.github.options": "GitHub publication options are unavailable.",
  "sessions.github.readiness": "GitHub publication readiness is unavailable.",
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
        : !publishing && method !== "sessions.github.action" && !busy && !timedOut;
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
  return isGitHubPublicationSuperseded(snapshot, async () => {
    const readTarget = createControlUiSessionPrRead({
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
      return undefined;
    }
    const assertReadCurrent = () => {
      assertCurrent();
      target.assertCurrent?.();
    };
    const published = await prOwner.read(target, assertReadCurrent, "publication");
    assertReadCurrent();
    return published.status === "ready" && !published.rateLimited
      ? { pullRequests: published.pullRequests, assertCurrent: assertReadCurrent }
      : undefined;
  });
}

export const sessionsGitHubHandlers: GatewayRequestHandlers = {
  "sessions.github.action": defineSessionGitHubMethod(
    "sessions.github.action",
    validateSessionGitHubActionParams,
    async (options) => {
      if (options.params.action === "prepare_pr") {
        await performSessionGitHubPreparation({ ...options, params: options.params });
        return;
      }
      if (options.params.action === "inspect_pr") {
        await performSessionGitHubInspection({ ...options, params: options.params });
        return;
      }
      if (options.params.action !== "refresh_base") {
        await performSessionGitHubAction({ ...options, params: options.params });
        return;
      }
      const caller = getGatewayToolCallerIdentity();
      const { params } = options;
      const sandbox = caller?.workspaceBaseRefreshSandbox;
      if (!canRefreshGitHubPublicationBase(sandbox)) {
        throw new Error(
          "refresh_base needs this session's writable managed sandbox workspace. Sessions that run directly on the host merge the base with git in their workspace, then publish.",
        );
      }
      if (
        caller &&
        (params.sessionKey !== caller.sessionKey ||
          (params.agentId && normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId)))
      ) {
        throw new Error("Base refresh must use the current conversation's workspace.");
      }
      using selected = await prepareGitHubPublicationSession(params.sessionKey, {
        agentId: caller?.agentId ?? params.agentId,
        assertCurrent: () => options.sessionMutationAuthorization?.assertCurrent(),
      });
      const loaded = selected.readCurrent();
      if (!loaded.entry?.sessionId) {
        throw new Error("The base refresh session is unavailable.");
      }
      if (loaded.entry.worktree?.githubPullRequest) {
        await performSessionGitHubPreparation({ ...options, params });
        return;
      }
      const session = { agentId: loaded.agentId, sessionKey: loaded.canonicalKey };
      const admitted = await prepareGitHubPublicationRequesterV2(options, session);
      using _ = { [Symbol.dispose]: admitted.release };
      const identity = await prepareCurrentGitHubPublicationIdentity(session.agentId);
      const assertCurrent = () => {
        selected.readCurrent();
        admitted.requester.assertCurrent();
        if (!matchesCurrentGitHubPublicationIdentity({ agentId: session.agentId, identity })) {
          throw new Error("The GitHub identity changed; retry refresh_base.");
        }
      };
      assertCurrent();
      using owner = await resolveLocalWorkspaceOwner({
        ...session,
        cfg: options.context.getRuntimeConfig(),
        assertCurrent,
      });
      if (!owner) {
        throw new Error("Base refresh requires this session's existing local managed workspace.");
      }
      const placements = options.context.workerSessionPlacementService;
      if (!placements?.withWorkspaceExclusion) {
        throw new Error("Workspace coordination is unavailable; retry after Gateway startup.");
      }
      const result = await placements.withWorkspaceExclusion(
        loaded.entry.sessionId,
        async (assertOwned) =>
          refreshManagedWorkspaceBase({
            owner,
            identity,
            sandbox,
            signal: options.signal,
            assertCurrent: assertOwned,
            conflictsResolved: params.conflictsResolved,
            baseCommit: params.baseCommit,
          }),
      );
      assertCurrent();
      options.respond(true, result);
    },
  ),
  "sessions.github.publish": defineSessionGitHubMethod(
    "sessions.github.publish",
    validateSessionGitHubPublishParams,
    async (options) => {
      const { params, respond, context, sessionMutationAuthorization } = options;

      const coordinator = context.githubPublicationService;
      if (!coordinator) {
        respondError(
          respond,
          ErrorCodes.UNAVAILABLE,
          "GitHub publication is unavailable on this Gateway",
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
        respondError(respond, ErrorCodes.INVALID_REQUEST, "GitHub publication session is invalid");
        return;
      }
      const agentId = caller?.agentId ?? params.agentId;
      if (params.selection?.source === "personal") {
        if (params.workspacePath !== undefined) {
          throw new Error("workspacePath requires the local agent publication handoff.");
        }
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
      using selectedSession = await prepareGitHubPublicationSession(sessionKey, {
        agentId,
        assertCurrent: () => sessionMutationAuthorization?.assertCurrent(),
        projection: params.workspacePath === undefined ? undefined : ["skillsSnapshot"],
      });
      const loaded = selectedSession.loaded;
      if (!loaded.entry?.sessionId) {
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          "GitHub publication session was not found",
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

      if (params.workspacePath !== undefined) {
        if (caller?.workspacePrAdoptionSessionId !== loaded.entry.sessionId) {
          throw new Error("Local checkout publication requires an agent handoff.");
        }
        if (loaded.entry.worktree) {
          using owner = await resolveLocalWorkspaceOwner({
            ...session,
            cfg: context.getRuntimeConfig(),
            assertCurrent: () => {
              selectedSession.readCurrent();
              admitted.requester.assertCurrent();
            },
          });
          const requestedPath = path.isAbsolute(params.workspacePath)
            ? await fs.realpath(params.workspacePath)
            : undefined;
          owner?.assertCurrent();
          // Existing ownership admits this checkout, even outside the default workspace.
          // canonicalWorkspaceDir is the skills/source workspace, not the owned checkout.
          if (!owner || owner.worktree.path !== requestedPath) {
            throw new Error(
              "This session already publishes a different checkout. Publish from its current managed worktree, or use a separate session for the other checkout; no files were moved or published.",
            );
          }
        } else {
          const source = await prepareSessionCreateRequestedCwd({
            cfg: context.getRuntimeConfig(),
            requestedCwd: params.workspacePath,
            clientPresent: true,
            clientScopes: admitted.requester.snapshot.scopes,
          });
          admitted.requester.assertCurrent();
          if (!source.ok) {
            throw new Error(source.error.message);
          }
          const placements = context.workerSessionPlacementService;
          if (!placements?.withLocalWorkspaceReservation) {
            throw new Error("Workspace preparation is unavailable during Gateway startup.");
          }
          await placements.withLocalWorkspaceReservation(
            { ...session, sessionId: loaded.entry.sessionId },
            (assertOwned) =>
              adoptUnboundPullRequestWorkspace({
                context,
                target: { ...session, storePath: loaded.storePath },
                entry: loaded.entry!,
                localSource: source.value,
                signal: options.signal,
                assertCurrent: () => {
                  admitted.requester.assertCurrent();
                  assertOwned();
                },
              }),
          );
        }
      }
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
  "sessions.github.readiness": defineSessionGitHubMethod(
    "sessions.github.readiness",
    validateSessionGitHubReadinessParams,
    async (options) => {
      const deadline = new AbortController();
      const result = await raceWithTimeout(
        () => readGitHubPublicationReadiness(options, options.params, deadline.signal),
        GITHUB_OPTIONS_TIMEOUT_MS,
        () => {
          const error = new GitHubOptionsTimeoutError();
          deadline.abort(error);
          throw error;
        },
        { ref: false },
      );
      options.respond(true, result);
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
            coordinator.latestShared(
              session,
              options.params.idempotencyKey,
              (snapshot) =>
                isSessionPublicationSuperseded(options, session, snapshot, assertResponseCurrent),
              read.currentSessionRead,
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
            const source = await qualifyGitHubPublicationSource(
              session,
              assertResponseCurrent,
              read.currentSessionRead,
            );
            if (!source.ok) {
              throw source.cause;
            }
            source.assertCurrent();
            if (source.target.kind !== "supported") {
              shared = null;
              sharedUnavailableReason = "unsupported_workspace";
            }
          }
          assertResponseCurrent();
          const personal =
            action && personalSnapshot
              ? service!.revalidateStatus(action, personalSnapshot)
              : personalSnapshot;
          // Personal publication accounts are always issued by github.com.
          const avatarUrls = {
            ...(shared && identity?.host
              ? { shared: githubAccountAvatarUrl(identity.host, shared.accountId) }
              : {}),
            ...(personal?.account
              ? { personal: githubAccountAvatarUrl("github.com", personal.account.accountId) }
              : {}),
          };
          options.respond(true, {
            personal,
            shared,
            ...(Object.keys(avatarUrls).length ? { avatarUrls } : {}),
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
