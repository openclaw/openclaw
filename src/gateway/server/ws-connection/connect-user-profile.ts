import { resolveHostAccountName } from "../../../infra/host-account-name.js";
import { prepareUserProfileRoleAuthority } from "../../../state/user-channel-identity-operations.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalUserProfileForTailscaleIdentity,
} from "../../../state/user-profile-writes.js";
import { adoptTailscaleProfileAvatar } from "../../../state/user-profiles.js";
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
import {
  bindGatewayConnectOperatorAccess,
  prepareGatewayConnectOperatorAccess,
} from "./connect-operator-access.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

type PreparedConnectProfile = Awaited<ReturnType<typeof resolveAuthenticatedProfile>>;

/** Provider identity enrichment remains owned by the admitted profile lifecycle. */
export function scheduleGatewayConnectProfileSync(params: {
  context: GatewayConnectPhaseContext;
  state: DeviceAuthorizedGatewayConnect;
  client: GatewayWsClient;
  lifecycle: ReturnType<typeof createGatewayConnectProfileLifecycle>;
  prepareIngress: (
    profile: PreparedConnectProfile["profile"],
  ) => ReturnType<typeof prepareGatewayLocalUserIngress>;
}): void {
  const { context, state, client, lifecycle, prepareIngress } = params;
  const { connId, logGateway } = context.handler;
  const { runDetachedConnectWork } = context;
  const { authResult } = state;
  const adoptProfileAvatar = async (profileId: string, profilePic: string) => {
    const updated = await adoptTailscaleProfileAvatar(profileId, profilePic);
    if (updated.avatarMime) {
      await lifecycle.attach(updated.id, updated.updatedAt, prepareIngress);
    }
  };
  if (client.authenticatedGitHubIdentitySync) {
    runDetachedConnectWork(
      async () => {
        const result = await client.authenticatedGitHubIdentitySync!();
        const profile = client.authenticatedUserProfile;
        const profilePic = authResult.tailscaleIdentity?.profilePic;
        if (!profile?.hasAvatar && profilePic) {
          try {
            await adoptProfileAvatar(result.profileId, profilePic);
          } catch (error) {
            logGateway.warn(
              `Tailscale avatar adoption failed conn=${connId}: ${formatForLog(error)}`,
            );
          }
        }
      },
      (error) => {
        logGateway.warn(`GitHub identity sync failed conn=${connId}: ${formatForLog(error)}`);
      },
    );
  }
  const tailscaleProfilePic = authResult.tailscaleIdentity?.profilePic;
  const tailscaleProfileId = client.authenticatedUserProfile?.profileId;
  if (
    !client.authenticatedGitHubIdentitySync &&
    tailscaleProfileId &&
    !client.authenticatedUserProfile?.hasAvatar &&
    tailscaleProfilePic
  ) {
    runDetachedConnectWork(
      () => adoptProfileAvatar(tailscaleProfileId, tailscaleProfilePic),
      (error) =>
        logGateway.warn(`Tailscale avatar adoption failed conn=${connId}: ${formatForLog(error)}`),
    );
  }
}

/** One connection retains its profile authority through admission and later identity refreshes. */
export function createGatewayConnectProfileLifecycle(
  context: GatewayConnectPhaseContext,
  state: DeviceAuthorizedGatewayConnect,
) {
  const { handler } = context;
  let client: GatewayWsClient | undefined;
  const clientCurrent = () =>
    !handler.isClosed() &&
    handler.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
    (!client || (handler.getClient() === client && !client.invalidated));
  const assertCurrent = () => {
    handler.connectionWork.signal.throwIfAborted();
    if (!clientCurrent() || resolveGatewayConnectPolicyFailure(context, state)) {
      throw new Error("Gateway profile acquisition authority expired");
    }
  };
  return {
    assertCurrent,
    isCurrent: (prepared: PreparedConnectProfile | undefined) =>
      (!prepared || prepared.authority.isCurrent()) &&
      !resolveGatewayConnectPolicyFailure(context, state),
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
      // Deferred attachment must prepare access without replacing an admitted grant.
      if (registered.internal?.operatorAccessAuthority === undefined) {
        prepareGatewayConnectOperatorAccess(registered);
        if (!bindGatewayConnectOperatorAccess(context, registered)) {
          return;
        }
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
      githubLogin: authority.githubLogin ?? null,
      aliases: new Set(authority.aliases),
    },
  };
}

/** Role and access policies need verified identity before admission; attribution alone may defer it. */
export async function resolveGatewayConnectProfileAdmission(params: {
  context: Pick<
    GatewayConnectPhaseContext,
    "configSnapshot" | "recordAttachTiming" | "setConnectPhase"
  > &
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
    params.assertCurrent?.();
    const options = { assertCurrent: params.assertCurrent };
    const ensureStartedAt = performance.now();
    context.setConnectPhase?.("profile-ensure");
    const profile = ownerProfileExpected
      ? await ensureCanonicalGatewayOwnerProfile(resolveHostAccountName, options)
      : params.resolveAuthenticatedGitHubIdentity
        ? await params.resolveAuthenticatedGitHubIdentity()
        : state.authResult.tailscaleIdentity
          ? await ensureCanonicalUserProfileForTailscaleIdentity(
              state.authResult.tailscaleIdentity,
              options,
            )
          : await ensureCanonicalUserProfileForEmail(authenticatedUserId!, options);
    params.assertCurrent?.();
    params.context.recordAttachTiming?.("profileEnsureMs", ensureStartedAt);
    const authorityStartedAt = performance.now();
    context.setConnectPhase?.("profile-authority");
    const prepared = await resolveAuthenticatedProfile(
      "profileId" in profile ? profile.profileId : profile.id,
      profile.updatedAt,
      params.assertCurrent,
    );
    params.assertCurrent?.();
    params.context.recordAttachTiming?.("profileAuthorityMs", authorityStartedAt);
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
