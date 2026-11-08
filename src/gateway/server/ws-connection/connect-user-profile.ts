import { resolveAuthenticatedPairedDeviceIdentity } from "../../../infra/device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../../../infra/device-pairing-store-readonly.js";
import { resolveHostAccountName } from "../../../infra/host-account-name.js";
import { readTailscaleWhoisIdentity } from "../../../infra/tailscale.js";
import { prepareUserProfileRoleAuthority } from "../../../state/user-channel-identity-operations.js";
import { resolveCanonicalTailscaleProfileId } from "../../../state/user-profile-reads.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  ensureCanonicalUserProfileForOpenClawIdIdentity,
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
import {
  captureGatewayPersonalIdentityBinding,
  captureGatewayPersonalIdentityBindingAuthority,
  resolveGatewayPersonalIdentityBinding,
  type PersonalIdentityBindingAuthority,
} from "../../personal-identity-binding.js";
import { WEBSOCKET_OPEN_READY_STATE } from "../../server-constants.js";
import { formatForLog } from "../../ws-log.js";
import { invalidateGatewayPolicyClient } from "../ws-policy-close.js";
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

export function bindGatewayConnectPersonalIdentity(
  client: GatewayWsClient,
  connectionSignal: AbortSignal,
): boolean {
  const binding = client.internal?.personalIdentityBinding;
  if (!binding) {
    return true;
  }
  const invalidate = () =>
    invalidateGatewayPolicyClient(client, {
      reason: "personal-identity-binding-invalidated",
      code: 4001,
      message: "personal identity binding is no longer current",
    });
  const release = () => binding.signal.removeEventListener("abort", invalidate);
  binding.signal.addEventListener("abort", invalidate, { once: true });
  connectionSignal.addEventListener("abort", release, { once: true });
  if (connectionSignal.aborted || !binding.isCurrent()) {
    release();
    connectionSignal.removeEventListener("abort", release);
    invalidate();
    return false;
  }
  return true;
}

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
  recordTiming?: GatewayConnectPhaseContext["recordAttachTiming"],
) {
  assertCurrent?.();
  const authorityStartedAt = performance.now();
  const authority = await prepareUserProfileRoleAuthority(profileId);
  recordTiming?.("profileAuthorityMs", authorityStartedAt);
  assertCurrent?.();
  if (!authority?.isCurrent()) {
    throw new Error("Gateway profile changed during acquisition");
  }
  const projectionStartedAt = performance.now();
  const { id, displayName, avatarRevision, hasAvatar } = authority.display;
  const prepared = {
    profile: { profileId: id, displayName, avatarRevision, hasAvatar, updatedAt },
    authority,
    recipient: {
      profileId: authority.profileId,
      role: authority.role,
      githubLogin: authority.githubLogin ?? null,
      aliases: new Set(authority.aliases),
    },
  };
  recordTiming?.("profileProjectionMs", projectionStartedAt);
  return prepared;
}

/** Role and access policies need verified identity before admission; attribution alone may defer it. */
export async function resolveGatewayConnectProfileAdmission(params: {
  context: Pick<
    GatewayConnectPhaseContext,
    "configSnapshot" | "recordAttachTiming" | "setConnectPhase" | "isLocalClient"
  > &
    Parameters<typeof rejectUnavailableProfileConnect>[0] & {
      connectParams: Pick<
        GatewayConnectPhaseContext["connectParams"],
        "personalIdentity" | "device" | "scopes"
      >;
      handler: Pick<
        GatewayConnectPhaseContext["handler"],
        "connId" | "logWsControl" | "clients" | "bootId" | "ingressAttribution"
      > & {
        buildRequestContext: () => Pick<
          ReturnType<GatewayConnectPhaseContext["handler"]["buildRequestContext"]>,
          "gatewayTlsFingerprint"
        >;
      };
    };
  state: Pick<DeviceAuthorizedGatewayConnect, "authResult" | "role" | "authMethod"> &
    Partial<
      Pick<
        DeviceAuthorizedGatewayConnect,
        "device" | "devicePublicKey" | "deviceAuthPayloadVersion"
      >
    >;
  ownerProfileExpected: boolean;
  authenticatedUserId: string | undefined;
  resolveAuthenticatedGitHubIdentity: ReturnType<typeof createAuthenticatedGitHubIdentitySync>;
  assertCurrent?: () => void;
}): Promise<
  | {
      ok: true;
      prepared?: PreparedConnectProfile;
      personalIdentityBinding?: PersonalIdentityBindingAuthority;
    }
  | { ok: false }
> {
  const { context, state, ownerProfileExpected, authenticatedUserId } = params;
  const profileRequired =
    Boolean(context.configSnapshot.gateway?.roles) ||
    hasGatewayOperatorAccessPolicies(context.configSnapshot);
  const personalIntent = context.connectParams.personalIdentity;
  let personalProfileId: string | undefined;
  let personalIdentityBinding: PersonalIdentityBindingAuthority | undefined;
  if (personalIntent && context.isLocalClient) {
    if (personalIntent.phase !== "use") {
      await rejectUnavailableProfileConnect(
        context,
        new Error("Personal identity bind must use Tailscale Serve"),
      );
      return { ok: false };
    }
    const pairing = state.device?.id
      ? await loadPairedDevicePairingStoreRecordReadOnly(state.device.id)
      : null;
    const pairingIdentity =
      state.role === "operator" &&
      pairing &&
      state.devicePublicKey &&
      state.deviceAuthPayloadVersion === "v4"
        ? resolveAuthenticatedPairedDeviceIdentity(pairing, {
            role: state.role,
            publicKey: state.devicePublicKey,
            scopes: context.connectParams.scopes ?? [],
          })
        : null;
    const localAuthMethodAllowed =
      state.authMethod === "device-token" ||
      state.authMethod === "token" ||
      state.authMethod === "password";
    const binding =
      pairingIdentity && localAuthMethodAllowed
        ? await resolveGatewayPersonalIdentityBinding({
            gateway: context.handler.clients,
            intent: personalIntent,
            device: pairingIdentity,
            gatewayId: context.handler.bootId,
            isDirectLocal:
              context.handler.ingressAttribution.kind === "direct-local" && context.isLocalClient,
            scopes: context.connectParams.scopes ?? [],
            isDeviceCurrent: async (identity) => {
              const current = await loadPairedDevicePairingStoreRecordReadOnly(identity.deviceId);
              const resolved = current
                ? resolveAuthenticatedPairedDeviceIdentity(current, {
                    role: state.role,
                    publicKey: state.devicePublicKey!,
                    scopes: context.connectParams.scopes ?? [],
                  })
                : null;
              return resolved?.key === identity.key;
            },
            isProfileCurrent: async (profileId, tailscaleLogin) => {
              const authority = await prepareUserProfileRoleAuthority(profileId);
              return (
                authority?.profileId === profileId &&
                (await resolveCanonicalTailscaleProfileId(tailscaleLogin)) === profileId &&
                authority.isCurrent()
              );
            },
            readCurrentTailscaleLogin: async (sourceClientIp) =>
              (
                await readTailscaleWhoisIdentity(sourceClientIp, undefined, {
                  cacheTtlMs: 0,
                  errorTtlMs: 0,
                })
              )?.login,
          })
        : undefined;
    if (!binding) {
      await rejectUnavailableProfileConnect(
        context,
        new Error("Personal Tailscale identity binding is unavailable or no longer current"),
      );
      return { ok: false };
    }
    personalProfileId = binding.profileId;
    personalIdentityBinding = binding;
  }
  if (
    !ownerProfileExpected &&
    !personalIntent &&
    (!authenticatedUserId || (params.resolveAuthenticatedGitHubIdentity && !profileRequired))
  ) {
    return { ok: true };
  }
  try {
    params.assertCurrent?.();
    const options = { assertCurrent: params.assertCurrent };
    const ensureStartedAt = performance.now();
    context.setConnectPhase?.("profile-ensure");
    const member =
      state.authMethod === "trusted-proxy" && state.authResult.openclawId?.kind === "member"
        ? state.authResult.openclawId
        : undefined;
    if (personalProfileId) {
      context.setConnectPhase?.("profile-authority");
    }
    const prepared = personalProfileId
      ? await resolveAuthenticatedProfile(
          personalProfileId,
          Date.now(),
          params.assertCurrent,
          context.recordAttachTiming,
        )
      : await (async () => {
          const profile = ownerProfileExpected
            ? await ensureCanonicalGatewayOwnerProfile(resolveHostAccountName, options)
            : member
              ? await ensureCanonicalUserProfileForOpenClawIdIdentity(
                  { accountId: member.accountId },
                  options,
                )
              : params.resolveAuthenticatedGitHubIdentity
                ? await params.resolveAuthenticatedGitHubIdentity()
                : state.authResult.tailscaleIdentity
                  ? await ensureCanonicalUserProfileForTailscaleIdentity(
                      state.authResult.tailscaleIdentity,
                      options,
                    )
                  : await ensureCanonicalUserProfileForEmail(authenticatedUserId!, options);
          params.assertCurrent?.();
          context.recordAttachTiming?.("profileEnsureMs", ensureStartedAt);
          context.setConnectPhase?.("profile-authority");
          return await resolveAuthenticatedProfile(
            "profileId" in profile ? profile.profileId : profile.id,
            profile.updatedAt,
            params.assertCurrent,
            context.recordAttachTiming,
          );
        })();
    params.assertCurrent?.();
    if (!prepared.authority.isCurrent()) {
      throw new Error("Gateway profile changed during acquisition");
    }
    if (personalIntent && !personalProfileId) {
      const ingress = context.handler.ingressAttribution;
      if (personalIntent.phase !== "bind") {
        await rejectUnavailableProfileConnect(
          context,
          new Error("Personal identity use intent requires a current local binding"),
        );
        return { ok: false };
      }
      const device = state.device;
      const pairing = device?.id
        ? await loadPairedDevicePairingStoreRecordReadOnly(device.id)
        : null;
      const pairingIdentity =
        state.role === "operator" &&
        state.authMethod === "tailscale" &&
        ingress.kind === "tailscale-serve" &&
        state.deviceAuthPayloadVersion === "v4" &&
        device &&
        state.devicePublicKey &&
        state.role === "operator" &&
        pairing
          ? resolveAuthenticatedPairedDeviceIdentity(pairing, {
              role: state.role,
              publicKey: state.devicePublicKey,
              scopes: context.connectParams.scopes ?? [],
            })
          : null;
      const providerIdentity =
        ingress.kind === "tailscale-serve" && pairingIdentity
          ? await readTailscaleWhoisIdentity(ingress.clientIp, undefined, {
              cacheTtlMs: 0,
              errorTtlMs: 0,
            })
          : null;
      const providerProfileId = providerIdentity?.login
        ? await resolveCanonicalTailscaleProfileId(providerIdentity.login)
        : undefined;
      params.assertCurrent?.();
      const canonicalProfileId = prepared.profile.profileId;
      const sourceBound = Boolean(
        personalIntent.mode === "personal-identity" &&
        personalIntent.provider === "tailscale" &&
        prepared.authority.isCurrent() &&
        state.authMethod === "tailscale" &&
        ingress.kind === "tailscale-serve" &&
        context.handler.buildRequestContext().gatewayTlsFingerprint &&
        providerIdentity?.login &&
        providerProfileId === canonicalProfileId &&
        state.authResult.tailscaleIdentity?.login.toLowerCase() ===
          providerIdentity.login.toLowerCase() &&
        pairingIdentity &&
        captureGatewayPersonalIdentityBinding(
          context.handler.clients,
          {
            ingress: ingress.kind,
            authMethod: state.authMethod,
            tailscaleLogin: providerIdentity.login,
            sourceClientIp: ingress.clientIp,
            canonicalProfileId,
            scopes: context.connectParams.scopes ?? [],
            device: pairingIdentity,
            gatewayId: context.handler.bootId,
            signedAtMs: context.connectParams.device?.signedAt ?? -1,
            verifiedAtMs: Date.now(),
          },
          personalIntent,
        ),
      );
      if (!sourceBound) {
        await rejectUnavailableProfileConnect(
          context,
          new Error(
            "A verified Tailscale Serve identity and local TLS trust could not bind this paired device",
          ),
        );
        return { ok: false };
      }
      if (!pairingIdentity || !providerIdentity?.login) {
        await rejectUnavailableProfileConnect(
          context,
          new Error("Personal identity binding proof was incomplete"),
        );
        return { ok: false };
      }
      personalIdentityBinding = captureGatewayPersonalIdentityBindingAuthority({
        gateway: context.handler.clients,
        bindingId: personalIntent.bindingId,
        device: pairingIdentity,
        gatewayId: context.handler.bootId,
        scopes: context.connectParams.scopes ?? [],
      });
      if (!personalIdentityBinding) {
        throw new Error("Personal identity binding changed before admission");
      }
    }
    return { ok: true, prepared, personalIdentityBinding };
  } catch (error) {
    context.handler.logWsControl.warn(
      `user profile resolution failed conn=${context.handler.connId} user=${formatForLog(authenticatedUserId)}: ${formatForLog(error)}`,
    );
    if (
      personalIntent ||
      (!ownerProfileExpected &&
        profileRequired &&
        state.role === "operator" &&
        state.authMethod !== "token" &&
        state.authMethod !== "password")
    ) {
      await rejectUnavailableProfileConnect(context, error);
      return { ok: false };
    }
    return { ok: true };
  }
}
