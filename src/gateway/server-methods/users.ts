import { isValidBase64 } from "@openclaw/media-core/base64";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  validateUsersLinkEmailParams,
  validateUsersMergeParams,
  validateUsersListParams,
  validateUsersPrefsGetParams,
  validateUsersPrefsSetParams,
  validateUsersSelfParams,
  validateUsersSetAvatarParams,
  validateUsersSetDisplayNameParams,
  validateUsersSetRoleParams,
  type ProtocolValidator,
  validateUsersAuthConnectCancelParams,
  validateUsersAuthConnectAnswerParams,
  validateUsersAuthConnectStartParams,
  validateUsersAuthConnectStatusParams,
  validateUsersAuthConnectCatalogParams,
  validateUsersListAuthLinksParams,
  validateUsersLinkAuthProfileParams,
  validateUsersUnlinkAuthProfileParams,
  validateUsersListModelAccountsParams,
  validateUsersSelectModelAccountParams,
  type UsersLinkChannelIdentityParams,
  validateUsersLinkChannelIdentityParams,
  validateUsersListChannelIdentitiesParams,
  validateUsersUnlinkChannelIdentityParams,
  validateUsersGitHubStatusParams,
  validateUsersGitHubAuthorizeStartParams,
  validateUsersGitHubAuthorizePollParams,
  validateUsersGitHubAuthorizeCancelParams,
  validateUsersGitHubDisconnectParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSystemGitHubIdentityStatus } from "../../agents/github-tool-identity.js";
import { resolveGatewayPersonalToolParticipant } from "../../agents/tools/gateway-caller-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { UserChannelIdentityConflictError } from "../../state/user-channel-identities.js";
import {
  changeCanonicalUserChannelIdentity,
  listCanonicalUserChannelIdentities,
} from "../../state/user-channel-identity-operations.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import { profileCatalogPath } from "../../state/user-profile-identity.read.js";
import {
  projectUserProfileDisplay,
  readResidentUserProfileRevision,
  readUserProfileSnapshot,
} from "../../state/user-profile-list.js";
import {
  linkCanonicalUserProfileEmail,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileAvatar,
  setCanonicalUserProfileDisplayName,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import { UserProfileMergeError, UserProfileOwnerError } from "../../state/user-profiles-schema.js";
import { listProfiles, UserProfileNotFoundError } from "../../state/user-profiles.js";
import type { PersonalGitHubAction } from "../github-personal-oauth.js";
import type { ModelAccountConnectAction } from "../model-account-authority.js";
import {
  ModelAccountConnectAuthorityError,
  ModelAccountConnectInputError,
} from "../model-account-connect-errors.js";
import {
  invalidateOperatorRolePolicy,
  resolveOperatorRoleSelection,
} from "../operator-role-policy.js";
import { broadcastChatMetadataChanged } from "../server-chat-metadata-lifecycle.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import {
  authenticatedProfileUnavailableError,
  isGatewayClientProfilePending,
} from "./gateway-client-identity.js";
import { preparePersonalProfileAction } from "./personal-profile-authorization.js";
import { respondError } from "./response.js";
import type {
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  GatewayRequestContext,
  GatewayRequestHandler,
} from "./types.js";
import { publishUserPreferencesChanged } from "./user-preference-events.js";
import { prepareUserBackgroundAction, usersBackgroundHandlers } from "./users-background.js";
import { usersChannelIdentityHandlers } from "./users-channel-identity.js";
import { prepareUserModelAccountAction } from "./users-model-account-access.js";
import { usersPersonalFileHandlers } from "./users-personal-file.js";
import {
  prepareAuthenticatedProfile,
  prepareProfileMutationAccess,
  prepareUserProfileAdministration,
} from "./users-profile-access.js";
import {
  assertValidParams,
  defineValidatedGatewayHandler,
  defineValidatedGatewayMethod,
  type Validator,
} from "./validation.js";

function refreshConnectedProfile(
  context: GatewayRequestHandlerOptions["context"],
  profileId: string,
): void {
  const current = readResidentUserProfileRevision(profileId, profileCatalogPath({}));
  if (current) {
    context.refreshConnectedUserProfile?.({
      ...projectUserProfileDisplay(current),
      updatedAt: current.updated_at,
    });
  }
}

function profileError(error: unknown) {
  if (
    error instanceof UserProfileNotFoundError ||
    error instanceof UserProfileOwnerError ||
    error instanceof UserProfileMergeError
  ) {
    return errorShape(ErrorCodes.INVALID_REQUEST, error.message);
  }
  return errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error));
}

function preparePersonalPreferences(client: GatewayRequestHandlerOptions["client"]) {
  const unavailable =
    "Personal settings are unavailable in this turn. Ask in your own Control UI turn with a new message.";
  try {
    const participant = resolveGatewayPersonalToolParticipant(
      client?.internal?.agentRuntimeIdentity,
      { requireSingleParticipant: true },
    );
    return () => {
      try {
        participant?.assertCurrent();
      } catch {
        throw new Error(unavailable);
      }
    };
  } catch {
    throw new Error(unavailable);
  }
}

function connectHandler<P extends { profileId?: string }>(
  method: string,
  validate: ProtocolValidator<P>,
  run: (
    service: NonNullable<GatewayRequestContext["modelAccountConnectService"]>,
    action: ModelAccountConnectAction,
    params: P,
  ) => unknown,
  requiredScope: "operator.read" | "operator.write" | "operator.admin" = "operator.write",
): GatewayRequestHandler {
  return defineValidatedGatewayHandler(
    method,
    validate,
    async (options) => {
      const action = await prepareUserModelAccountAction(
        options,
        options.params.profileId,
        requiredScope,
      );
      const service = options.context.modelAccountConnectService;
      if (!service) {
        throw new Error("Model-account service is not running.");
      }
      const result = await run(service, action, options.params);
      action.assertCurrent();
      options.respond(true, result);
    },
    (error) =>
      error instanceof ModelAccountConnectAuthorityError
        ? errorShape(ErrorCodes.FORBIDDEN, error.message)
        : error instanceof ModelAccountConnectInputError ||
            error instanceof UserProfileNotFoundError
          ? errorShape(ErrorCodes.INVALID_REQUEST, error.message)
          : errorShape(
              ErrorCodes.UNAVAILABLE,
              "Model account connect is unavailable right now; try again shortly.",
            ),
  );
}

function identityError(error: unknown) {
  return errorShape(
    error instanceof UserChannelIdentityConflictError ||
      error instanceof UserProfileNotFoundError ||
      error instanceof UserProfileOwnerError
      ? ErrorCodes.INVALID_REQUEST
      : ErrorCodes.UNAVAILABLE,
    formatErrorMessage(error),
  );
}

function identityMutationHandler(
  method: "users.linkChannelIdentity" | "users.unlinkChannelIdentity",
  validate: Validator<UsersLinkChannelIdentityParams>,
  action: "link" | "unlink",
) {
  return defineValidatedGatewayMethod(
    method,
    validate,
    async (options) => {
      const { params, respond } = options;
      const assertCurrent = await prepareUserProfileAdministration(options);
      const result = await changeCanonicalUserChannelIdentity(
        action,
        params.profileId,
        params.identity,
        { assertCurrent },
      );
      respond(true, result.kind === "linked" ? result.link : { removed: result.removed });
    },
    identityError,
  );
}

async function runPersonalGitHub(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal" | "respond">,
  fallbackError: string,
  run: (
    action: PersonalGitHubAction,
    service: NonNullable<GatewayRequestContext["githubOAuthService"]>["personal"],
  ) => unknown,
): Promise<void> {
  const fail = (error: unknown) =>
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, error instanceof Error ? error.message : fallbackError),
    );
  try {
    const action = await preparePersonalProfileAction(options);
    const service = options.context.githubOAuthService?.personal;
    if (!service) {
      throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
    }
    const result = await run(action, service);
    action.assertCurrent();
    options.respond(true, result);
  } catch (error) {
    fail(error);
  }
}

export const usersHandlers: GatewayRequestHandlers = {
  "users.listAuthLinks": connectHandler(
    "users.listAuthLinks",
    validateUsersListAuthLinksParams,
    (service, action) => service.listLinksAsync(action),
    "operator.read",
  ),
  "users.linkAuthProfile": connectHandler(
    "users.linkAuthProfile",
    validateUsersLinkAuthProfileParams,
    (service, action, params) => service.linkAsync(action, params.authProfileId),
    // Choosing an existing shared credential remains an explicit admin decision.
    "operator.admin",
  ),
  "users.unlinkAuthProfile": connectHandler(
    "users.unlinkAuthProfile",
    validateUsersUnlinkAuthProfileParams,
    (service, action, params) => service.unlinkAsync(action, params.provider),
  ),
  "users.listModelAccounts": connectHandler(
    "users.listModelAccounts",
    validateUsersListModelAccountsParams,
    (service, action, params) => service.listAsync(action, params.cursor),
    "operator.read",
  ),
  "users.selectModelAccount": connectHandler(
    "users.selectModelAccount",
    validateUsersSelectModelAccountParams,
    (service, action, params) => service.selectAsync(action, params.authProfileId),
  ),
  "users.authConnect.start": connectHandler(
    "users.authConnect.start",
    validateUsersAuthConnectStartParams,
    (service, action, params) => service.start(action, params.provider, params.method),
  ),
  "users.authConnect.answer": connectHandler(
    "users.authConnect.answer",
    validateUsersAuthConnectAnswerParams,
    (service, action, params) =>
      service.answer(action, params.connectId, params.stepId, params.value),
  ),
  "users.authConnect.status": connectHandler(
    "users.authConnect.status",
    validateUsersAuthConnectStatusParams,
    (service, action, params) => service.statusAsync(action, params.connectId),
  ),
  "users.authConnect.cancel": connectHandler(
    "users.authConnect.cancel",
    validateUsersAuthConnectCancelParams,
    (service, action, params) => service.cancelAsync(action, params.connectId),
  ),
  "users.authConnect.catalog": connectHandler(
    "users.authConnect.catalog",
    validateUsersAuthConnectCatalogParams,
    (service, action) => service.catalog(action),
  ),
  "users.linkChannelIdentity": identityMutationHandler(
    "users.linkChannelIdentity",
    validateUsersLinkChannelIdentityParams,
    "link",
  ),
  "users.unlinkChannelIdentity": identityMutationHandler(
    "users.unlinkChannelIdentity",
    validateUsersUnlinkChannelIdentityParams,
    "unlink",
  ),
  "users.listChannelIdentities": defineValidatedGatewayMethod(
    "users.listChannelIdentities",
    validateUsersListChannelIdentitiesParams,
    async (options) => {
      const { params, respond } = options;
      const assertCurrent = await prepareUserProfileAdministration(options);
      const links = await listCanonicalUserChannelIdentities(params.profileId);
      assertCurrent();
      respond(true, { links });
    },
    identityError,
  ),
  "users.github.status": defineValidatedGatewayMethod(
    "users.github.status",
    validateUsersGitHubStatusParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub is unavailable.", async (action, service) => {
        const config = options.context.getRuntimeConfig();
        const system = await resolveSystemGitHubIdentityStatus({
          config,
          sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
        });
        const personal = await service.status(action);
        return { personal, system };
      }),
  ),
  "users.github.authorize.start": defineValidatedGatewayMethod(
    "users.github.authorize.start",
    validateUsersGitHubAuthorizeStartParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub authorization failed.", (action, service) =>
        service.startAuthorization(action),
      ),
  ),
  "users.github.authorize.poll": defineValidatedGatewayMethod(
    "users.github.authorize.poll",
    validateUsersGitHubAuthorizePollParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub authorization failed.", (action, service) =>
        service.pollAuthorization(action, options.params.requestId),
      ),
  ),
  "users.github.authorize.cancel": defineValidatedGatewayMethod(
    "users.github.authorize.cancel",
    validateUsersGitHubAuthorizeCancelParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub authorization failed.", async (action, service) => ({
        cancelled: await service.cancelAuthorizationAsync(action, options.params.requestId),
      })),
  ),
  "users.github.disconnect": defineValidatedGatewayMethod(
    "users.github.disconnect",
    validateUsersGitHubDisconnectParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub disconnect failed.", async (action, service) => {
        await service.disconnectAsync(action);
        return { disconnected: true };
      }),
  ),
  ...usersPersonalFileHandlers,
  ...usersChannelIdentityHandlers,
  ...usersBackgroundHandlers,
  "users.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateUsersListParams, "users.list", respond)) {
      return;
    }
    const { githubAccountIds } = params;
    const result =
      githubAccountIds === undefined
        ? { profiles: await listProfiles() }
        : await readUserProfileSnapshot(githubAccountIds);
    const cfg = context.getRuntimeConfig();
    const profilesById = new Map(result.profiles.map((profile) => [profile.id, profile]));
    respond(true, {
      ...result,
      profiles: result.profiles.map((profile) => {
        const canonical = profilesById.get(profile.mergedInto ?? profile.id) ?? profile;
        return Object.assign(
          profile,
          resolveOperatorRoleSelection(
            canonical.id,
            canonical.role ?? null,
            cfg,
            canonical.githubIdentity?.host ? null : (canonical.githubIdentity?.login ?? null),
          ),
        );
      }),
    });
  },
  "users.self": async (options) => {
    const { client, params, respond } = options;
    if (!assertValidParams(params, validateUsersSelfParams, "users.self", respond)) {
      return;
    }
    if (!client?.authenticatedUserId && !client?.authenticatedUserProfile) {
      respondError(respond, ErrorCodes.FORBIDDEN, "users.self requires an authenticated user");
      return;
    }
    try {
      let syncError: unknown;
      if (client.authenticatedGitHubIdentitySync) {
        try {
          await client.authenticatedGitHubIdentitySync();
        } catch (error) {
          // A previously attached immutable profile stays usable; unresolved aliases stay hidden.
          syncError = error;
        }
      }
      const profile = await prepareAuthenticatedProfile(options, true);
      profile.assertCurrent();
      const profileId = profile.profileId;
      if (!profileId || !profile.listItem) {
        respond(false, undefined, authenticatedProfileUnavailableError(syncError));
        return;
      }
      respond(true, { profile: profile.listItem });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.prefs.get": async ({ client, params, respond, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateUsersPrefsGetParams, "users.prefs.get", respond)) {
      return;
    }
    const profileId = client?.authenticatedUserProfile?.profileId ?? "";
    if (!profileId) {
      if (isGatewayClientProfilePending(client)) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      respond(true, { status: "no_durable_identity" }, undefined);
      return;
    }
    try {
      const assertCurrent = preparePersonalPreferences(client);
      const preferences = await getCanonicalUserPreferences(profileId, params.keys);
      assertCurrent();
      sessionMutationAuthorization?.assertCurrent();
      if (!preferences) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      respond(true, { status: "ok", entries: preferences.entries }, undefined);
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      respond(false, undefined, profileError(error));
    }
  },
  "users.prefs.set": async (options) => {
    const { client, context, params, respond } = options;
    if (!assertValidParams(params, validateUsersPrefsSetParams, "users.prefs.set", respond)) {
      return;
    }
    const profileId = client?.authenticatedUserProfile?.profileId ?? "";
    if (!profileId) {
      if (isGatewayClientProfilePending(client)) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      respond(true, { status: "no_durable_identity" }, undefined);
      return;
    }
    try {
      const assertPersonal = preparePersonalPreferences(client);
      const backgroundAction = Object.hasOwn(params.entries, "ui.background")
        ? await prepareUserBackgroundAction(options, "operator.write")
        : undefined;
      const assertCurrent = () => {
        assertPersonal();
        options.sessionMutationAuthorization?.assertCurrent();
        backgroundAction?.assertCurrent();
      };
      const result = await setCanonicalUserPreferences(profileId, params.entries, {
        expectedEntries: params.expectedEntries,
        assertCurrent,
      });
      if (!result) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      if (!result.ok) {
        if (result.error.code === "conflict") {
          respond(true, { status: "conflict" }, undefined);
          return;
        }
        if (result.error.code === "profile-key-limit") {
          respondError(
            respond,
            ErrorCodes.INVALID_REQUEST,
            `users.prefs.set exceeds the ${result.error.limit}-key profile limit (current count: ${result.error.currentCount})`,
            {
              details: {
                code: GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED,
                limit: result.error.limit,
                currentCount: result.error.currentCount,
              },
            },
          );
          return;
        }
        const key = "key" in result.error ? ` for ${result.error.key}` : "";
        respondError(
          respond,
          ErrorCodes.INVALID_REQUEST,
          `invalid users.prefs.set entry${key}: ${result.error.code}`,
        );
        return;
      }
      respond(true, { status: "ok" }, undefined);
      publishUserPreferencesChanged(context, result.value.profileId, Object.keys(params.entries));
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.linkEmail": async (options) => {
    const { context, params, respond } = options;
    if (!assertValidParams(params, validateUsersLinkEmailParams, "users.linkEmail", respond)) {
      return;
    }
    const email = params.email.trim();
    if (!email) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "email must not be empty");
      return;
    }
    const targetProfileId = params.targetProfileId;
    try {
      const assertCurrent = await prepareUserProfileAdministration(options);
      const { profile } = await linkCanonicalUserProfileEmail(email, targetProfileId, {
        assertCurrent,
      });
      assertCurrent();
      refreshConnectedProfile(context, profile.id);
      broadcastChatMetadataChanged(context);
      respond(true, { profile });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.merge": defineValidatedGatewayHandler(
    "users.merge",
    validateUsersMergeParams,
    async (options) => {
      const { context, params, respond } = options;
      const assertCurrent = await prepareUserProfileAdministration(options);
      holdGatewayPolicyResponse(respond);
      const { profile, movedAliasKinds } = await mergeCanonicalUserProfiles(
        params.sourceProfileId,
        params.targetProfileId,
        {
          assertCurrent,
          onCommitted: (profileIds) => {
            for (const profileId of profileIds) {
              invalidateOperatorRolePolicy(profileId);
              context.disconnectClientsForUserProfile?.(profileId);
            }
          },
        },
      );
      let canPublish = true;
      try {
        assertCurrent();
      } catch {
        // A committed merge can revoke its requester; its receipt still completes the held response.
        canPublish = false;
      }
      if (canPublish) {
        refreshConnectedProfile(context, profile.id);
        broadcastChatMetadataChanged(context);
      }
      respond(true, { profile, movedAliasKinds });
    },
    profileError,
  ),
  "users.setDisplayName": defineValidatedGatewayHandler(
    "users.setDisplayName",
    validateUsersSetDisplayNameParams,
    async (options) => {
      const { context, params, respond } = options;
      const assertCurrent = await prepareProfileMutationAccess(options, params.profileId);
      if (!assertCurrent) {
        return;
      }
      const { profile } = await setCanonicalUserProfileDisplayName(
        params.profileId,
        params.displayName,
        { assertCurrent },
      );
      assertCurrent();
      refreshConnectedProfile(context, profile.id);
      respond(true, { profile });
    },
    profileError,
  ),
  "users.setRole": async (options) => {
    const { context, params, respond } = options;
    if (!assertValidParams(params, validateUsersSetRoleParams, "users.setRole", respond)) {
      return;
    }
    const { profileId, role } = params;
    const isConfiguredRole = () => {
      const definitions = context.getRuntimeConfig().gateway?.roles?.definitions;
      return role === null || (definitions !== undefined && Object.hasOwn(definitions, role));
    };
    const unknownRoleMessage = `unknown operator role "${role}"; define it under gateway.roles.definitions before assigning it`;
    if (!isConfiguredRole()) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, unknownRoleMessage);
      return;
    }
    try {
      const assertCurrent = await prepareUserProfileAdministration(options);
      holdGatewayPolicyResponse(respond);
      const profile = await setCanonicalUserProfileRole(profileId, role, {
        assertCurrent: () => {
          assertCurrent();
          if (!isConfiguredRole()) {
            throw new Error(unknownRoleMessage);
          }
        },
        onCommitted: (canonicalProfileId) => {
          invalidateOperatorRolePolicy(canonicalProfileId);
          context.disconnectClientsForUserProfile?.(canonicalProfileId);
        },
      });
      respond(true, { profile });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.setAvatar": async (options) => {
    const { context, params, respond } = options;
    if (!assertValidParams(params, validateUsersSetAvatarParams, "users.setAvatar", respond)) {
      return;
    }
    const avatarBase64 = params.avatarBase64.trim();
    if (!isValidBase64(avatarBase64)) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "avatarBase64 must be base64");
      return;
    }
    const bytes = Buffer.from(avatarBase64, "base64");
    try {
      const assertCurrent = await prepareProfileMutationAccess(options, params.profileId);
      if (!assertCurrent) {
        return;
      }
      const result = await setCanonicalUserProfileAvatar(params.profileId, bytes, params.mime, {
        assertCurrent,
      });
      assertCurrent();
      if (!result.ok) {
        respondError(respond, ErrorCodes.INVALID_REQUEST, result.error.code);
        return;
      }
      const { profile, display } = result.value;
      refreshConnectedProfile(context, profile.id);
      respond(true, { profile, avatarRevision: display.avatarRevision });
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
};
