import {
  ErrorCodes,
  errorShape,
  validateUsersGitLabStatusParams,
  validateUsersGitLabAuthorizeStartParams,
  validateUsersGitLabAuthorizeCompleteParams,
  validateUsersGitLabDisconnectParams,
  validateSessionGitLabOptionsParams,
  validateSessionGitLabStatusParams,
  validateSessionGitLabConfirmParams,
  validateSessionGitLabPublishParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  personalGitLabPublicationCredential,
  type GitLabPublicationCredential,
} from "../gitlab-personal-publication-identity.js";
import { prepareManagedGitLabPublicationCredential } from "../gitlab-personal-publication-managed.js";
import {
  confirmPersonalGitLabPublication,
  readGitLabPublicationPublisher,
  readPersonalGitLabPublicationOptions,
  readPersonalGitLabPublicationStatus,
  requestPersonalGitLabPublication,
} from "../gitlab-personal-publication.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import {
  preparePersonalGitLabPublicationOptionsRead,
  preparePersonalGitLabSessionActionV2,
} from "./github-personal-authorization.js";
import {
  preparePersonalForgeAction,
  type PersonalForgeAction,
} from "./personal-forge-authorization.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type Options = Pick<
  GatewayRequestHandlerOptions,
  | "client"
  | "context"
  | "signal"
  | "respond"
  | "req"
  | "hasCurrentClientAuthority"
  | "sessionMutationCommitGuard"
  | "sessionMutationAuthorization"
>;

function respondFailure(options: Options, error: unknown, message: string) {
  options.respond(
    false,
    undefined,
    errorShape(ErrorCodes.FORBIDDEN, error instanceof Error ? error.message : message),
  );
}

function rejectSelection(options: Options, idempotencyKey: string): void {
  options.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.UNAVAILABLE,
      "The selected GitLab publisher is unavailable or changed; review publication options and retry.",
      { details: { code: "GITLAB_PUBLICATION_SELECTION_REJECTED", idempotencyKey } },
    ),
  );
}

async function selectedPublicationCredential(
  options: Options,
  action: PersonalForgeAction & { agentId: string },
  source: "personal" | "shared",
): Promise<GitLabPublicationCredential> {
  if (source === "shared") {
    return prepareManagedGitLabPublicationCredential({
      config: options.context.getRuntimeConfig(),
      getCurrentConfig: options.context.getRuntimeConfig,
      agentId: action.agentId,
      assertCurrent: action.assertCurrent,
    });
  }
  const service = options.context.gitlabOAuthService;
  if (!service) {
    throw new Error("My GitLab is unavailable; retry after Gateway startup.");
  }
  return personalGitLabPublicationCredential(await service.credential(action));
}

function assertRequestedOwner(
  options: Options,
  target: { sessionKey: string; agentId?: string },
): void {
  if (target.agentId === undefined) {
    return;
  }
  const owner = resolveRequestedSessionAgentId(
    options.context.getRuntimeConfig(),
    target.sessionKey,
    target.agentId,
  );
  if (!owner.ok) {
    throw new Error(owner.error.message);
  }
}

async function personal<T>(
  options: Options,
  run: (
    action: Awaited<ReturnType<typeof preparePersonalForgeAction>>,
    service: NonNullable<Options["context"]["gitlabOAuthService"]>,
  ) => Promise<T>,
) {
  try {
    const action = await preparePersonalForgeAction(options, "operator.read", undefined, "GitLab");
    const service = options.context.gitlabOAuthService;
    if (!service) {
      throw new Error("My GitLab is unavailable; retry after Gateway startup.");
    }
    const result = await run(action, service);
    action.assertCurrent();
    options.respond(true, result);
  } catch (error) {
    respondFailure(options, error, "My GitLab action failed.");
  }
}

/** Native session actions use the same direct human connection and requester custody as GitHub. */
export const gitLabHandlers: GatewayRequestHandlers = {
  "users.gitlab.status": defineValidatedGatewayMethod(
    "users.gitlab.status",
    validateUsersGitLabStatusParams,
    async (options) => {
      if (!options.context.getRuntimeConfig().gateway?.gitlab) {
        options.respond(true, { configured: false });
        return;
      }
      await personal(options, async (action, service) => {
        let status = await service.status(action);
        let verificationUnavailable = false;
        if (status.connected) {
          try {
            // Like GitHub status, prove the selected account can still authenticate.
            await service.credential(action);
            status = await service.status(action);
          } catch {
            action.assertCurrent();
            const current = await service.status(action);
            verificationUnavailable = current.connected;
            status = { ...current, connected: false };
          }
        }
        return {
          ...status,
          verificationUnavailable,
          account: status.account
            ? { accountId: status.account.accountId, login: status.account.login }
            : null,
        };
      });
    },
  ),
  "users.gitlab.authorize.start": defineValidatedGatewayMethod(
    "users.gitlab.authorize.start",
    validateUsersGitLabAuthorizeStartParams,
    (options) => personal(options, (action, service) => service.start(action)),
  ),
  "users.gitlab.authorize.complete": defineValidatedGatewayMethod(
    "users.gitlab.authorize.complete",
    validateUsersGitLabAuthorizeCompleteParams,
    (options) =>
      personal(options, async (action, service) => {
        const status = await service.complete(
          action,
          options.params.requestId,
          options.params.callbackUrl,
        );
        return {
          ...status,
          account: status.account
            ? { accountId: status.account.accountId, login: status.account.login }
            : null,
        };
      }),
  ),
  "users.gitlab.disconnect": defineValidatedGatewayMethod(
    "users.gitlab.disconnect",
    validateUsersGitLabDisconnectParams,
    (options) => personal(options, (action, service) => service.disconnect(action)),
  ),
  "sessions.gitlab.options": defineValidatedGatewayMethod(
    "sessions.gitlab.options",
    validateSessionGitLabOptionsParams,
    async (options) => {
      try {
        assertRequestedOwner(options, options.params);
        using prepared = await preparePersonalGitLabPublicationOptionsRead(options, options.params);
        if (!prepared.action) {
          options.respond(true, {
            issuer: null,
            personal: null,
            shared: null,
            sharedUnavailableReason: "unavailable",
            pendingPersonal: null,
            latestShared: null,
            target: null,
          });
          return;
        }
        const result = await readPersonalGitLabPublicationOptions(
          options,
          prepared.action,
          options.params.idempotencyKey,
        );
        prepared.action.assertCurrent();
        options.respond(true, result);
      } catch (error) {
        respondFailure(options, error, "GitLab publication options are unavailable.");
      }
    },
  ),
  "sessions.gitlab.status": defineValidatedGatewayMethod(
    "sessions.gitlab.status",
    validateSessionGitLabStatusParams,
    async (options) => {
      try {
        assertRequestedOwner(options, options.params);
        using prepared = await preparePersonalGitLabPublicationOptionsRead(options, options.params);
        if (!prepared.action) {
          throw new Error("GitLab publication was not found for this session and caller.");
        }
        const publisher = await readGitLabPublicationPublisher(
          options,
          prepared.action,
          options.params.requestId,
        );
        let credential: GitLabPublicationCredential | null = null;
        try {
          credential = await selectedPublicationCredential(
            options,
            prepared.action,
            publisher.source === "personal" ? "personal" : "shared",
          );
        } catch {
          // The original receipt remains readable when its publisher is unavailable.
          prepared.action.assertCurrent();
        }
        let result;
        try {
          result = await readPersonalGitLabPublicationStatus(
            options,
            prepared.action,
            credential,
            options.params.requestId,
          );
        } finally {
          credential?.close();
        }
        prepared.action.assertCurrent();
        options.respond(true, result);
      } catch (error) {
        respondFailure(options, error, "GitLab publication status is unavailable.");
      }
    },
  ),
  "sessions.gitlab.confirm": defineValidatedGatewayMethod(
    "sessions.gitlab.confirm",
    validateSessionGitLabConfirmParams,
    async (options) => {
      try {
        assertRequestedOwner(options, options.params);
        const admitted = await preparePersonalGitLabSessionActionV2(
          options,
          options.params,
          "sessions.gitlab.confirm",
        );
        using _ = { [Symbol.dispose]: () => admitted.release() };
        const publisher = await readGitLabPublicationPublisher(
          options,
          admitted.action,
          options.params.requestId,
        );
        const credential = await selectedPublicationCredential(
          options,
          admitted.action,
          publisher.source === "personal" ? "personal" : "shared",
        );
        let result;
        try {
          result = await confirmPersonalGitLabPublication(
            options,
            admitted.action,
            credential,
            options.params,
          );
        } finally {
          credential.close();
        }
        admitted.action.assertCurrent();
        options.respond(true, result);
      } catch (error) {
        respondFailure(options, error, "GitLab publication confirmation failed.");
      }
    },
  ),
  "sessions.gitlab.publish": defineValidatedGatewayMethod(
    "sessions.gitlab.publish",
    validateSessionGitLabPublishParams,
    async (options) => {
      const { params } = options;
      if (!params.selection || !params.sessionKey) {
        rejectSelection(options, params.idempotencyKey);
        return;
      }
      try {
        assertRequestedOwner(options, { sessionKey: params.sessionKey, agentId: params.agentId });
        const admitted = await preparePersonalGitLabSessionActionV2(options, {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
        });
        using _ = { [Symbol.dispose]: () => admitted.release() };
        const credential = await selectedPublicationCredential(
          options,
          admitted.action,
          params.selection.source,
        );
        let result;
        try {
          const selected = params.selection;
          if (
            (selected.source === "personal" &&
              (credential.generation !== selected.generation ||
                credential.account.accountId !== selected.account.accountId ||
                credential.account.login !== selected.account.login)) ||
            (selected.source === "shared" &&
              selected.expected &&
              (credential.publisher.source !== selected.expected.source ||
                credential.account.accountId !== selected.expected.accountId ||
                credential.account.login !== selected.expected.login))
          ) {
            rejectSelection(options, params.idempotencyKey);
            return;
          }
          result = await requestPersonalGitLabPublication(
            options,
            admitted.action,
            credential,
            params,
          );
        } finally {
          credential.close();
        }
        admitted.action.assertCurrent();
        options.respond(true, result);
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        respondFailure(options, error, "GitLab publication request failed.");
      }
    },
  ),
};
