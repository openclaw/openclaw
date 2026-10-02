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
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveGatewayPersonalToolParticipant } from "../../agents/tools/gateway-caller-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import { profileCatalogPath } from "../../state/user-profile-identity.read.js";
import {
  projectUserProfileDisplay,
  readResidentUserProfileRevision,
} from "../../state/user-profile-list.js";
import { readUserProfileSnapshot } from "../../state/user-profile-reads.js";
import {
  linkCanonicalUserProfileEmail,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileAvatar,
  setCanonicalUserProfileDisplayName,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import { UserProfileMergeError, UserProfileOwnerError } from "../../state/user-profiles-schema.js";
import {
  getUserProfileListItem,
  listProfiles,
  UserProfileNotFoundError,
} from "../../state/user-profiles.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { broadcastChatMetadataChanged } from "../server-chat-metadata-lifecycle.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import {
  authenticatedProfileUnavailableError,
  isGatewayClientProfilePending,
} from "./gateway-client-identity.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { publishUserPreferencesChanged } from "./user-preference-events.js";
import { usersAuthConnectHandlers } from "./users-auth-connect.js";
import { usersChannelIdentityHandlers } from "./users-channel-identities.js";
import { usersGitHubHandlers } from "./users-github.js";
import { usersPersonalFileHandlers } from "./users-personal-file.js";
import {
  prepareAuthenticatedProfile,
  prepareProfileMutationAccess,
  prepareUserProfileAdministration,
} from "./users-profile-access.js";
import { assertValidParams } from "./validation.js";

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

export const usersHandlers: GatewayRequestHandlers = {
  ...usersAuthConnectHandlers,
  ...usersChannelIdentityHandlers,
  ...usersGitHubHandlers,
  ...usersPersonalFileHandlers,
  "users.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validateUsersListParams, "users.list", respond)) {
      return;
    }
    const { githubAccountIds } = params;
    respond(
      true,
      githubAccountIds === undefined
        ? { profiles: await listProfiles() }
        : await readUserProfileSnapshot(githubAccountIds),
    );
  },
  "users.self": async (options) => {
    const { client, params, respond } = options;
    if (!assertValidParams(params, validateUsersSelfParams, "users.self", respond)) {
      return;
    }
    if (!client?.authenticatedUserId && !client?.authenticatedUserProfile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "users.self requires an authenticated user"),
      );
      return;
    }
    try {
      if (client.authenticatedGitHubIdentitySync) {
        try {
          await client.authenticatedGitHubIdentitySync();
        } catch {
          // A previously attached immutable profile stays usable; unresolved aliases stay hidden.
        }
      }
      const profile = await prepareAuthenticatedProfile(options);
      profile.assertCurrent();
      const profileId = profile.profileId;
      if (!profileId) {
        respond(false, undefined, authenticatedProfileUnavailableError());
        return;
      }
      respond(true, { profile: getUserProfileListItem(profileId) });
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
  "users.prefs.set": async ({ client, context, params, respond }) => {
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
      const assertCurrent = preparePersonalPreferences(client);
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
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `users.prefs.set exceeds the ${result.error.limit}-key profile limit (current count: ${result.error.currentCount})`,
              {
                details: {
                  code: GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED,
                  limit: result.error.limit,
                  currentCount: result.error.currentCount,
                },
              },
            ),
          );
          return;
        }
        const key = "key" in result.error ? ` for ${result.error.key}` : "";
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid users.prefs.set entry${key}: ${result.error.code}`,
          ),
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
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "email must not be empty"));
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
  "users.merge": async (options) => {
    const { context, params, respond } = options;
    if (!assertValidParams(params, validateUsersMergeParams, "users.merge", respond)) {
      return;
    }
    try {
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
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
  "users.setDisplayName": async (options) => {
    const { context, params, respond } = options;
    if (
      !assertValidParams(params, validateUsersSetDisplayNameParams, "users.setDisplayName", respond)
    ) {
      return;
    }
    try {
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
    } catch (error) {
      respond(false, undefined, profileError(error));
    }
  },
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
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, unknownRoleMessage));
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
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "avatarBase64 must be base64"),
      );
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
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error.code));
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
