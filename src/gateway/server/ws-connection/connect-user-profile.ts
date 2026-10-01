import { isDeepStrictEqual } from "node:util";
import { getRuntimeConfig } from "../../../config/io.js";
import { resolveHostAccountName } from "../../../infra/host-account-name.js";
import { prepareUserProfileRoleAuthority } from "../../../state/user-channel-identity-operations.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalUserProfileForTailscaleIdentity,
} from "../../../state/user-profile-writes.js";
import type { GatewayAuthResult } from "../../auth.js";
import { prepareGatewayRecipientProfile } from "../../expected-profile.js";
import type { createAuthenticatedGitHubIdentitySync } from "../../github-user-identity.js";
import {
  attachGatewayLocalUserIngress,
  type prepareGatewayLocalUserIngress,
} from "../../local-user-ingress.js";
import { hasGatewayOperatorAccessPolicies } from "../../operator-access-policy.js";
import { WEBSOCKET_OPEN_READY_STATE } from "../../server-constants.js";
import { formatForLog } from "../../ws-log.js";
import type { GatewayWsClient } from "../ws-types.js";
import {
  rejectUnavailableProfileConnect,
  resolveGatewayConnectPolicyFailure,
} from "./connect-admission.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

type PreparedConnectProfile = Awaited<ReturnType<typeof resolveAuthenticatedProfile>>;

/** One connection retains its profile authority through admission and later identity refreshes. */
export function createGatewayConnectProfileLifecycle(
  context: GatewayConnectPhaseContext,
  state: DeviceAuthorizedGatewayConnect,
) {
  const { handler } = context;
  let client: GatewayWsClient | undefined;
  const rolesCurrent = () =>
    isDeepStrictEqual(context.configSnapshot.gateway?.roles, getRuntimeConfig().gateway?.roles);
  const clientCurrent = () =>
    !handler.isClosed() &&
    handler.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
    (!client || (handler.getClient() === client && !client.invalidated));
  const assertCurrent = () => {
    handler.connectionWork.signal.throwIfAborted();
    if (!clientCurrent() || resolveGatewayConnectPolicyFailure(context, state) || !rolesCurrent()) {
      throw new Error("Gateway profile acquisition authority expired");
    }
  };
  return {
    assertCurrent,
    isCurrent: (prepared: PreparedConnectProfile | undefined) =>
      (!prepared || prepared.authority.isCurrent()) && rolesCurrent(),
    bind: (registered: GatewayWsClient) => {
      client = registered;
    },
    async attach(
      profileId: string,
      updatedAt: number,
      prepareIngress: (
        profile: PreparedConnectProfile["profile"],
      ) => ReturnType<typeof prepareGatewayLocalUserIngress>,
    ) {
      if (!client || !clientCurrent()) {
        return;
      }
      const registered = client;
      assertCurrent();
      const prepared = await resolveAuthenticatedProfile(profileId, updatedAt, assertCurrent);
      assertCurrent();
      if (client !== registered || !prepared.authority.isCurrent()) {
        throw new Error("Gateway profile changed before attachment");
      }
      const { profile } = prepared;
      registered.preparedRecipientProfileId = undefined;
      if (registered.authenticatedUserProfile) {
        Object.assign(registered.authenticatedUserProfile, profile);
      } else {
        registered.authenticatedUserProfile = profile;
      }
      prepareGatewayRecipientProfile(registered, { identity: prepared.recipient });
      attachGatewayLocalUserIngress(registered, prepareIngress(profile));
      const { profileId: id, ...display } = profile;
      handler.buildRequestContext().refreshConnectedUserProfile?.({ id, ...display });
    },
  };
}

async function resolveAuthenticatedProfile(
  profileId: string,
  updatedAt: number,
  assertCurrent?: () => void,
) {
  assertCurrent?.();
  const authority = await prepareUserProfileRoleAuthority(profileId);
  assertCurrent?.();
  if (!authority?.isCurrent()) {
    throw new Error("Gateway profile changed during acquisition");
  }
  const { id, displayName, avatarRevision, hasAvatar } = authority.display;
  return {
    profile: { profileId: id, displayName, avatarRevision, hasAvatar, updatedAt },
    authority,
    recipient: {
      profileId: authority.profileId,
      role: authority.role,
      aliases: new Set(authority.aliases),
    },
  };
}

async function resolveGatewayConnectUserProfile(params: {
  ownerProfileExpected: boolean;
  authenticatedUserId: string | undefined;
  authResult: GatewayAuthResult;
  resolveAuthenticatedGitHubIdentity: ReturnType<typeof createAuthenticatedGitHubIdentitySync>;
  assertCurrent?: () => void;
}) {
  params.assertCurrent?.();
  const options = { assertCurrent: params.assertCurrent };
  const ownerDisplayName = params.ownerProfileExpected ? await resolveHostAccountName() : undefined;
  params.assertCurrent?.();
  const profile = params.ownerProfileExpected
    ? await ensureCanonicalGatewayOwnerProfile(ownerDisplayName ?? null, options)
    : params.resolveAuthenticatedGitHubIdentity
      ? await params.resolveAuthenticatedGitHubIdentity()
      : params.authResult.tailscaleIdentity
        ? await ensureCanonicalUserProfileForTailscaleIdentity(
            params.authResult.tailscaleIdentity,
            options,
          )
        : await ensureCanonicalUserProfileForEmail(params.authenticatedUserId!, options);
  params.assertCurrent?.();
  const profileId = "profileId" in profile ? profile.profileId : profile.id;
  const resolved = await resolveAuthenticatedProfile(
    profileId,
    profile.updatedAt,
    params.assertCurrent,
  );
  params.assertCurrent?.();
  return resolved;
}

/** Role and access policies need verified identity before admission; attribution alone may defer it. */
export async function resolveGatewayConnectProfileAdmission(params: {
  context: Pick<GatewayConnectPhaseContext, "configSnapshot"> &
    Parameters<typeof rejectUnavailableProfileConnect>[0] & {
      handler: Pick<GatewayConnectPhaseContext["handler"], "connId" | "logWsControl">;
    };
  state: Pick<DeviceAuthorizedGatewayConnect, "authResult" | "role" | "authMethod">;
  ownerProfileExpected: boolean;
  authenticatedUserId: string | undefined;
  resolveAuthenticatedGitHubIdentity: ReturnType<typeof createAuthenticatedGitHubIdentitySync>;
  assertCurrent?: () => void;
}): Promise<{ ok: true; prepared?: PreparedConnectProfile } | { ok: false }> {
  const { context, state, ownerProfileExpected, authenticatedUserId } = params;
  const profileRequired =
    Boolean(context.configSnapshot.gateway?.roles) ||
    hasGatewayOperatorAccessPolicies(context.configSnapshot);
  if (
    !ownerProfileExpected &&
    (!authenticatedUserId || (params.resolveAuthenticatedGitHubIdentity && !profileRequired))
  ) {
    return { ok: true };
  }
  try {
    const prepared = await resolveGatewayConnectUserProfile({
      ownerProfileExpected,
      authenticatedUserId,
      authResult: state.authResult,
      resolveAuthenticatedGitHubIdentity: params.resolveAuthenticatedGitHubIdentity,
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent?.();
    if (!prepared.authority.isCurrent()) {
      throw new Error("Gateway profile changed during acquisition");
    }
    return { ok: true, prepared };
  } catch (error) {
    context.handler.logWsControl.warn(
      `user profile resolution failed conn=${context.handler.connId} user=${formatForLog(authenticatedUserId)}: ${formatForLog(error)}`,
    );
    if (
      !ownerProfileExpected &&
      profileRequired &&
      state.role === "operator" &&
      state.authMethod !== "token" &&
      state.authMethod !== "password"
    ) {
      await rejectUnavailableProfileConnect(context, error);
      return { ok: false };
    }
    return { ok: true };
  }
}
