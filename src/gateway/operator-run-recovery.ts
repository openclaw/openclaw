import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import {
  intersectOperatorModelPolicies,
  restoreOperatorModelPolicySnapshot,
} from "../agents/operator-model-policy-state.js";
import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPairedDeviceTokenIdentityCurrent } from "../infra/device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../infra/device-pairing-store-readonly.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import { getCanonicalGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  operatorScopeSatisfied,
  intersectOperatorScopes,
} from "../shared/operator-scope-compat.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { profileCatalogPath } from "../state/user-profile-identity.read.js";
import {
  prepareUserProfileIdentity,
  projectUserProfileDisplay,
  readResidentUserProfileRevision,
} from "../state/user-profile-list.js";
import { captureGatewayAuthPolicy, isGatewayAuthGrantCurrent } from "./auth-policy.js";
import type { GatewayAuthPolicy } from "./auth-policy.types.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import { gatewayPersonPrincipalAuthError } from "./auth.js";
import { prepareChannelOperatorAuthority } from "./channel-operator-authority.js";
import {
  captureGatewayDeviceRevocation,
  onGatewayDeviceSourceRevoked,
} from "./device-revocation.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  onOpenClawIdTunnelPrincipalsChanged,
  openclawIdTunnelRolePolicy,
  prepareOpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import {
  GatewayOperatorAccessDeniedError,
  resumeGatewayOperatorAccessGrant,
} from "./operator-access-policy.js";
import {
  onOperatorRolePolicyChanged,
  readOperatorRoleConfigRevision,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import {
  isOperatorRoleSourcePolicyCurrent,
  sourceRolePolicy,
} from "./operator-role-source-policy.js";
import {
  bindGatewayOperatorContinuationAuthority,
  captureChannelOperatorRunAuthority,
} from "./operator-run-authority.js";
import {
  decodeQueuedOperatorRecoverySource,
  type OperatorRunRecoverySnapshot,
} from "./operator-run-recovery-source.codec.js";
import { getGatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { restoreIngressPrincipalRecovery } from "./remote-ingress-principal-recovery.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import type { GatewayAuthenticatedUserProfile } from "./server/client-identity-types.js";

export type RestoredGatewayOperatorAuthority = {
  authority: AdmittedRunOperatorAuthority;
  /** Original caller policy remains authoritative when its recovered execution is canceled. */
  assertPolicyCurrent: () => void;
  authenticatedUserProfile: GatewayAuthenticatedUserProfile;
  controlUiAdmin: boolean;
  release: () => void;
};

type PreparedOperatorRecoverySource = {
  snapshot: OperatorRunRecoverySnapshot;
  revalidate: () => Promise<void>;
};

/** Explicit scheduled work retains its original authenticated grant and current policy checks. */
async function restoreGatewayOperatorSnapshot(params: {
  context: GatewayRequestContext;
  assertCurrent: () => void;
  subscribeToClaim?: (revoke: () => void) => () => void;
  prepareSource: () => Promise<PreparedOperatorRecoverySource | undefined>;
}): Promise<RestoredGatewayOperatorAuthority | undefined> {
  const { context, assertCurrent } = params;
  const getConfig = context.getCommittedRuntimeConfig ?? context.getRuntimeConfig;
  const gatewayOwner = context.resolveGatewayContext?.() ?? context;
  let references = 1;
  const signal = new AbortController();
  const revoke = (cause?: unknown) =>
    signal.abort(
      cause instanceof GatewayOperatorRecoveryAuthorizationError
        ? new GatewayOperatorRecoveryAuthorizationError(undefined, { cause })
        : new Error("Restart recovery operator authority changed; start a new user turn.", {
            cause,
          }),
    );
  const assertLifetime = () => {
    if (references === 0) {
      throw new Error("Restart recovery operator authority is no longer active.");
    }
    signal.signal.throwIfAborted();
  };
  const subscriptions: Array<() => void> = [];
  // The claimed target's lifecycle ends this restored run, not work it already
  // handed to another session; that continuation keeps the policy signal only.
  const claim = new AbortController();
  if (params.subscribeToClaim) {
    subscriptions.push(
      params.subscribeToClaim(() =>
        claim.abort(
          new Error("Restart recovery operator authority changed; start a new user turn."),
        ),
      ),
    );
  }
  let identity: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  const releaseHold = () => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (--references === 0) {
        subscriptions.splice(0).forEach((release) => release());
        identity?.release();
      }
    };
  };
  const release = releaseHold();
  try {
    const prepared = await params.prepareSource();
    assertLifetime();
    assertCurrent();
    if (!prepared) {
      release();
      return undefined;
    }
    const snapshot = prepared.snapshot;
    const ingress =
      snapshot.sourceIngress === "principal"
        ? await restoreIngressPrincipalRecovery(
            context,
            snapshot.ingress,
            snapshot.profileId,
            snapshot.scopes,
          )
        : undefined;
    assertLifetime();
    if (ingress) {
      ingress.signal.addEventListener("abort", revoke, { once: true });
      subscriptions.push(() => ingress.signal.removeEventListener("abort", revoke));
    }
    const principal = snapshot.openclawIdPrincipal;
    const membershipPolicy = openclawIdTunnelRolePolicy(principal);
    if (principal) {
      await prepareOpenClawIdTunnelPrincipal(principal);
    }
    assertLifetime();
    assertCurrent();
    const generationOwner = context.sharedGatewaySessionGenerationState;
    if (snapshot.sharedGeneration !== undefined) {
      if (!generationOwner || generationOwner.requiredGeneration !== snapshot.sharedGeneration) {
        throw new Error("Restart recovery authentication owner changed; start a new user turn.");
      }
      subscriptions.push(
        generationOwner.onInvalidated(
          snapshot.sharedGeneration,
          () => revoke(new GatewayOperatorRecoveryAuthorizationError()),
          snapshot.authPolicy,
        ),
      );
    }
    const device = captureGatewayDeviceRevocation(
      gatewayOwner,
      { deviceId: snapshot.device?.deviceId, role: "operator" },
      () => !signal.signal.aborted,
    );
    subscriptions.push(device.release);
    const releaseDeviceNotification = onGatewayDeviceSourceRevoked(device.isCurrent, revoke);
    if (releaseDeviceNotification) {
      subscriptions.push(releaseDeviceNotification);
    }
    let authPolicy: GatewayAuthPolicy | undefined = snapshot.authPolicy;
    let sourceConfig: OpenClawConfig | undefined;
    let sourceRevision: object | undefined;
    let sourcePublication: object | undefined;
    const assertSourcePolicy = () => {
      assertLifetime();
      ingress?.assertCurrent();
      const cfg = getConfig();
      const revision = readOperatorRoleConfigRevision(gatewayOwner);
      const publication = runtimeConfigPublication.current?.revision;
      if (
        (principal && !isOpenClawIdTunnelPrincipalCurrent(principal)) ||
        !device.isCurrent() ||
        (snapshot.sharedGeneration !== undefined &&
          context.sharedGatewaySessionGenerationState !== generationOwner)
      ) {
        throw new Error("Restart recovery operator source policy changed.");
      }
      if (
        ((cfg !== sourceConfig ||
          revision !== sourceRevision ||
          publication !== sourcePublication) &&
          !isOperatorRoleSourcePolicyCurrent(
            snapshot.rolePolicy,
            sourceRolePolicy(
              membershipPolicy ??
                resolveOperatorRolePolicyForAssignment(
                  snapshot.profileId,
                  snapshot.assignedRole,
                  cfg,
                  snapshot.githubLogin,
                ),
            ),
            snapshot.scopes,
          )) ||
        (authPolicy !== undefined && !principal && !isGatewayAuthGrantCurrent(authPolicy, cfg))
      ) {
        throw new GatewayOperatorRecoveryAuthorizationError(
          "Restart recovery operator source policy changed.",
        );
      }
      // Retain this config's issued policy only after validating the original grant.
      if (authPolicy) {
        authPolicy = captureGatewayAuthPolicy(cfg, authPolicy);
      }
      // The decoded admission is frozen. Reconcile it once per live owner's publication;
      // profile assignments, device lifetime, and plugin grants still check every use.
      sourceConfig = cfg;
      sourceRevision = revision;
      sourcePublication = publication;
      return cfg;
    };
    let assertPolicy = assertSourcePolicy;
    const assertRecoveryCurrent = () => {
      claim.signal.throwIfAborted();
      assertCurrent();
      return assertPolicy();
    };
    const recheck = () => {
      if (references > 0 && !signal.signal.aborted) {
        try {
          assertPolicy();
        } catch (error) {
          revoke(error);
        }
      }
    };
    // Subscribe before preparation yields: a committed downgrade remains revoked
    // even if another update restores the same role or authentication policy.
    subscriptions.push(
      onOperatorRolePolicyChanged((change) => {
        if (change.kind === "assignment" && change.profileId === snapshot.profileId) {
          revoke(new GatewayOperatorRecoveryAuthorizationError());
        } else if (change.kind === "config" && change.context === gatewayOwner) {
          recheck();
        }
      }),
    );
    if (principal) {
      subscriptions.push(onOpenClawIdTunnelPrincipalsChanged(recheck));
    }
    assertRecoveryCurrent();
    identity = await prepareUserProfileIdentity(snapshot.profileId);
    const profileIdentity = identity;
    let githubAccountIds: readonly number[] | undefined;
    let profileRevision: object | undefined;
    let profileFacts: ReturnType<typeof profileIdentity.readCurrentFacts>["profile"] | undefined;
    const assertFacts = () => {
      const cfg = assertSourcePolicy();
      // The bound owner still checks lifetime, settlement, and email bindings on every use.
      const revision = profileIdentity.readCurrentRevision(snapshot.aliasBindingIds);
      if (!profileFacts || revision !== profileRevision) {
        const profile = profileIdentity.readCurrentFacts(snapshot.aliasBindingIds).profile;
        if (
          profile.profileId !== snapshot.profileId ||
          profile.assignedRole !== snapshot.assignedRole ||
          (profile.githubLogin ?? null) !== snapshot.githubLogin ||
          githubAccountIds?.some((accountId) => !profile.githubAccountIds?.includes(accountId))
        ) {
          throw new GatewayOperatorRecoveryAuthorizationError(
            "Restart recovery operator identity changed.",
          );
        }
        githubAccountIds ??= profile.githubAccountIds ?? [];
        profileFacts = profile;
        profileRevision = revision;
      }
      if (
        snapshot.sourceIngress === "principal" &&
        snapshot.profileId !== GATEWAY_OWNER_PROFILE_ID
      ) {
        // The transport owns effective auth overrides; headless contexts resolve their config.
        const resolver = context.resolveGatewayContext
          ? getCanonicalGatewayContextResolver(context.resolveGatewayContext)
          : undefined;
        const host = resolver ? getGatewayControlUiIngressHost(resolver) : undefined;
        const eligibilityError = gatewayPersonPrincipalAuthError(
          host?.getResolvedAuth() ?? resolveGatewayAuthForConfig({ config: cfg }),
          cfg,
          profileFacts.emails,
        );
        if (eligibilityError) {
          throw new GatewayOperatorRecoveryAuthorizationError(eligibilityError);
        }
      }
      return { cfg, profile: profileFacts };
    };
    let accessAuthority: ReturnType<typeof resumeGatewayOperatorAccessGrant>;
    assertPolicy = () => {
      try {
        const { profile, cfg } = assertFacts();
        const access = resumeGatewayOperatorAccessGrant(
          profile,
          cfg,
          snapshot.grant,
          accessAuthority,
        );
        if (access && !accessAuthority) {
          accessAuthority = access;
          const onAbort = () => revoke(access.signal.reason);
          access.signal.addEventListener("abort", onAbort, { once: true });
          subscriptions.push(() => access.signal.removeEventListener("abort", onAbort));
        }
        // The grant assertion can synchronously abort its signal.
        accessAuthority?.signal.throwIfAborted();
        // A policy callback can change committed identity/config synchronously.
        return assertFacts().cfg;
      } catch (error) {
        const failure =
          signal.signal.reason instanceof GatewayOperatorRecoveryAuthorizationError
            ? signal.signal.reason
            : error instanceof GatewayOperatorAccessDeniedError
              ? new GatewayOperatorRecoveryAuthorizationError(error.message, { cause: error })
              : error;
        revoke(failure);
        throw failure;
      }
    };
    subscriptions.push(onUserProfilesChanged(recheck));
    assertRecoveryCurrent();
    if (snapshot.device) {
      const paired = await loadPairedDevicePairingStoreRecordReadOnly(snapshot.device.deviceId);
      if (
        !isPairedDeviceTokenIdentityCurrent(paired, "operator", snapshot.device, snapshot.scopes)
      ) {
        revoke(new GatewayOperatorRecoveryAuthorizationError());
      }
    }
    assertRecoveryCurrent();
    await prepared.revalidate();
    assertRecoveryCurrent();
    const live = captureChannelOperatorRunAuthority({
      profileId: snapshot.profileId,
      openclawIdPrincipal: principal,
      assignedRole: snapshot.assignedRole,
      githubLogin: snapshot.githubLogin,
      scopes: snapshot.scopes,
      gatewayAccessGrant: snapshot.grant,
      getRuntimeConfig: getConfig,
      assertCurrent: assertPolicy,
      signal: signal.signal,
    });
    const originalModels = snapshot.modelPolicy
      ? restoreOperatorModelPolicySnapshot(snapshot.modelPolicy)
      : undefined;
    const retainPolicy = () => {
      assertPolicy();
      references += 1;
      return releaseHold();
    };
    const policyAuthority = createAdmittedRunOperatorAuthority({
      ...live,
      signal: signal.signal,
      recoverySnapshot: snapshot,
      retain: retainPolicy,
      get modelPolicy() {
        return intersectOperatorModelPolicies(originalModels, live.modelPolicy);
      },
    });
    const authority = createAdmittedRunOperatorAuthority({
      ...policyAuthority,
      signal: AbortSignal.any([signal.signal, claim.signal]),
      assertCurrent: assertRecoveryCurrent,
      retain: () => {
        claim.signal.throwIfAborted();
        assertCurrent();
        return retainPolicy();
      },
      get modelPolicy() {
        return policyAuthority.modelPolicy;
      },
    });
    bindGatewayOperatorContinuationAuthority(authority, policyAuthority);
    authority.assertCurrent();
    const profile = readResidentUserProfileRevision(snapshot.profileId, profileCatalogPath({}));
    if (!profile) {
      throw new Error("Restart recovery operator profile is unavailable.");
    }
    const { id, ...display } = projectUserProfileDisplay(profile);
    return {
      authority,
      assertPolicyCurrent: () => {
        assertPolicy();
      },
      authenticatedUserProfile: { profileId: id, ...display, updatedAt: profile.updated_at },
      controlUiAdmin:
        snapshot.controlUiAdmin && operatorScopeSatisfied("operator.admin", authority.scopes),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Restore owner-held continuation evidence through the shared authentication owner. */
export async function restoreGatewayOperatorSource(params: {
  snapshot: OperatorRunRecoverySnapshot;
  target?: { agentId: string; sessionKey: string; sessionId: string };
  context: GatewayRequestContext;
  assertCurrent: () => void;
  prepareCurrent?: () => Promise<void>;
}): Promise<RestoredGatewayOperatorAuthority> {
  const target = params.target ? { ...params.target } : undefined;
  const restored = await restoreGatewayOperatorSnapshot({
    context: params.context,
    assertCurrent: params.assertCurrent,
    subscribeToClaim: target
      ? (revoke) =>
          onSessionIdentityMutation((mutation) => {
            if (
              mutation.agentId === target.agentId &&
              (mutation.previous.sessionId === target.sessionId ||
                mutation.previous.sessionKeys.includes(target.sessionKey))
            ) {
              revoke();
            }
          })
      : undefined,
    prepareSource: async () => ({
      snapshot: params.snapshot,
      revalidate: async () => {
        await params.prepareCurrent?.();
      },
    }),
  });
  if (!restored) {
    throw new Error("Operator continuation recovery source is unavailable.");
  }
  return restored;
}

/** A queued native launch reuses its original authenticated source, never profile attribution. */
export async function restoreGatewayQueuedOperatorRecovery(params: {
  source: unknown;
  context: GatewayRequestContext;
  assertCurrent: () => void;
}): Promise<Pick<RestoredGatewayOperatorAuthority, "authority" | "controlUiAdmin" | "release">> {
  params.assertCurrent();
  const source = decodeQueuedOperatorRecoverySource(params.source);
  if (source.kind === "unavailable") {
    throw new Error("Queued operator authority cannot be recovered; submit a new request.");
  }
  if (source.kind === "gateway") {
    const restored = await restoreGatewayOperatorSnapshot({
      context: params.context,
      assertCurrent: params.assertCurrent,
      prepareSource: async () => ({
        snapshot: source.snapshot,
        revalidate: async () => params.assertCurrent(),
      }),
    });
    if (!restored) {
      throw new Error("Queued operator recovery source is unavailable.");
    }
    return restored;
  }
  const snapshot = source.snapshot;
  const getConfig = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
  const prepared = await prepareChannelOperatorAuthority(getConfig(), snapshot.reference);
  params.assertCurrent();
  const profile = prepared?.operatorProfile;
  if (!profile || profile.profileId !== snapshot.profileId || !prepared?.isCurrent(getConfig())) {
    throw new Error("Queued channel operator authority changed; submit a new request.");
  }
  let references = 1;
  const assertCurrent = () => {
    if (references === 0) {
      throw new Error("Queued channel operator authority is no longer active.");
    }
    params.assertCurrent();
    if (!prepared.isCurrent(getConfig())) {
      throw new Error("Queued channel operator authority changed; submit a new request.");
    }
  };
  const live = captureChannelOperatorRunAuthority({
    ...profile,
    recoveryReference: snapshot.reference,
    scopes: intersectOperatorScopes(snapshot.scopes, profile.scopes),
    getRuntimeConfig: getConfig,
    assertCurrent,
    signal: prepared.signal,
  });
  // Every hold keeps the live revocation subscribed, so retained work settles on revocation.
  const releaseHold = () => {
    const releaseLive = live.retain?.();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        references -= 1;
        releaseLive?.();
      }
    };
  };
  const release = releaseHold();
  const originalModels = snapshot.modelPolicy
    ? restoreOperatorModelPolicySnapshot(snapshot.modelPolicy)
    : undefined;
  try {
    const authority = createAdmittedRunOperatorAuthority({
      ...live,
      channelRecoverySource: { reference: snapshot.reference, modelPolicy: originalModels },
      retain: () => {
        if (references === 0) {
          throw new Error("Queued channel operator authority is no longer active.");
        }
        references += 1;
        try {
          // The live check latches a refusal into the signal every retained holder observes.
          return releaseHold();
        } catch (error) {
          references -= 1;
          throw error;
        }
      },
      get modelPolicy() {
        return intersectOperatorModelPolicies(originalModels, live.modelPolicy);
      },
    });
    authority.assertCurrent();
    return { authority, controlUiAdmin: false, release };
  } catch (error) {
    release();
    throw error;
  }
}
