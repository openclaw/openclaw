import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { restoreOperatorModelPolicySnapshot } from "../agents/operator-model-policy.js";
import {
  isPairedDeviceTokenIdentityCurrent,
  listApprovedPairedDeviceRoles,
} from "../infra/device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../infra/device-pairing-store-readonly.js";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import { getCanonicalGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  operatorScopeSatisfied,
  intersectOperatorScopes,
} from "../shared/operator-scope-compat.js";
import { UserProfileMutationUnsettledError } from "../state/user-profile-events.js";
import { profileCatalogPath } from "../state/user-profile-identity.read.js";
import {
  prepareUserProfileIdentity,
  projectUserProfileDisplay,
  readResidentUserProfileRevision,
} from "../state/user-profile-list.js";
import type { PreparedUserProfileIdentity } from "../state/user-profiles.types.js";
import { isGatewayAuthGrantCurrent } from "./auth-policy.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import { gatewayPersonPrincipalAuthError } from "./auth.js";
import { prepareChannelOperatorAuthority } from "./channel-operator-authority.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  prepareOpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import {
  GatewayOperatorAccessDeniedError,
  resolvePreparedGatewayOperatorAccessAuthority,
} from "./operator-access-policy.js";
import { resolveIdentityOperatorScopes } from "./operator-identity-scopes.js";
import { operatorRoleSubject } from "./operator-role-enforcement.js";
import {
  captureChannelOperatorRunAuthority,
  prepareGatewayOperatorRunAuthority,
  intersectOperatorRunModelPolicy,
  type GatewayOperatorRunAdmissionInput,
  type PreparedGatewayOperatorRunAuthority,
} from "./operator-run-authority.js";
import {
  decodeQueuedOperatorRecoverySource,
  hasAutomationAdminDelegation,
  type OperatorRunRecoverySnapshot,
} from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { checkGatewayWsBrowserOrigin } from "./origin-check.js";
import { getGatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { restoreIngressPrincipalRecovery } from "./remote-ingress-principal-recovery.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import type { GatewayAuthenticatedUserProfile } from "./server/client-identity-types.js";

export type RestoredGatewayOperatorAuthority = {
  authority: AdmittedRunOperatorAuthority;
  authenticatedUserProfile: GatewayAuthenticatedUserProfile;
  controlUiAdmin: boolean;
  automationAdmin: boolean;
  release: () => void;
};

/** Admit the saved requester against current access; historical role definitions are not grants. */
async function restoreGatewayOperatorSnapshot(params: {
  context: GatewayRequestContext;
  snapshot: OperatorRunRecoverySnapshot;
  assertCurrent: () => void;
  subscribeToClaim?: (cancel: () => void) => () => void;
  prepareCurrent?: () => Promise<void>;
}): Promise<RestoredGatewayOperatorAuthority> {
  const { context, snapshot } = params;
  const principal = snapshot.openclawIdPrincipal;
  let preparedIdentity: PreparedUserProfileIdentity | undefined;
  let ingress:
    | { assertCurrent: () => void; release: () => void; scopes: readonly string[] }
    | undefined;
  let releaseClaim: (() => void) | undefined;
  let references = 1;
  const claim = new AbortController();
  const assertCurrent = () => {
    if (references === 0) {
      throw new Error("Restart recovery operator authority is no longer active.");
    }
    claim.signal.throwIfAborted();
    params.assertCurrent();
  };
  const releaseHold = () => {
    let released = false;
    return () => {
      if (!released) {
        released = true;
        if (--references === 0) {
          releaseClaim?.();
        }
      }
    };
  };
  const release = releaseHold();
  try {
    const identity = await prepareUserProfileIdentity(snapshot.profileId);
    preparedIdentity = identity;
    releaseClaim = params.subscribeToClaim?.(() =>
      claim.abort(new Error("The requesting chat was deleted; start a new user turn.")),
    );
    if (principal) {
      await prepareOpenClawIdTunnelPrincipal(principal);
    }
    const paired = snapshot.device
      ? await loadPairedDevicePairingStoreRecordReadOnly(snapshot.device.deviceId)
      : undefined;
    if (snapshot.sourceIngress === "principal") {
      ingress = await restoreIngressPrincipalRecovery(
        context,
        snapshot.ingress,
        snapshot.profileId,
        snapshot.scopes,
      );
    }
    await params.prepareCurrent?.();
    assertCurrent();
    const config = (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)();
    const profile = identity.readCurrentFacts(snapshot.aliasBindingIds).profile;
    if (profile.profileId !== snapshot.profileId) {
      throw new GatewayOperatorRecoveryAuthorizationError();
    }
    if (principal && !isOpenClawIdTunnelPrincipalCurrent(principal)) {
      throw new GatewayOperatorRecoveryAuthorizationError();
    }
    // Proxy generations describe transport headers, not the credential of accepted work.
    const sharedGeneration =
      snapshot.authPolicy?.authMethod === "trusted-proxy" && !principal
        ? undefined
        : snapshot.sharedGeneration;
    if (sharedGeneration !== undefined) {
      const owner = context.sharedGatewaySessionGenerationState;
      if (!owner) {
        throw new GatewayOperatorAccessUnavailableError();
      }
      if (owner.requiredGeneration !== sharedGeneration) {
        throw new GatewayOperatorRecoveryAuthorizationError(
          "The Gateway credential changed; submit a new authenticated request.",
        );
      }
    }
    let scopes = ingress
      ? intersectOperatorScopes(snapshot.scopes, ingress.scopes)
      : snapshot.scopes;
    const identityScopes =
      snapshot.authPolicy?.verifiedIdentity && !principal
        ? resolveIdentityOperatorScopes(
            snapshot.authPolicy.verifiedIdentity,
            config.gateway?.auth?.identityScopes,
          )
        : [];
    if (snapshot.device) {
      const tokenCurrent = isPairedDeviceTokenIdentityCurrent(
        paired ?? null,
        "operator",
        snapshot.device,
        [],
      );
      const pairedProxyCurrent =
        !principal &&
        snapshot.authPolicy?.authMethod === "trusted-proxy" &&
        paired &&
        paired.deviceId === snapshot.device.deviceId &&
        snapshot.device.key === sha256Hex(paired.publicKey) &&
        listApprovedPairedDeviceRoles(paired).includes("operator") &&
        !paired.tokens?.operator?.revokedAtMs;
      if (!tokenCurrent && !pairedProxyCurrent) {
        throw new GatewayOperatorRecoveryAuthorizationError();
      }
      if (tokenCurrent) {
        scopes = intersectOperatorScopes(scopes, [
          ...(paired?.tokens?.operator?.scopes ?? []),
          ...identityScopes,
        ]);
      }
    } else if (snapshot.authPolicy?.authMethod === "tailscale") {
      scopes = intersectOperatorScopes(scopes, identityScopes);
    }
    if (snapshot.authPolicy && !principal) {
      const source = snapshot.authPolicy;
      const auth = resolveGatewayAuthForConfig({
        config,
        authOverride: source.authModeOverride ? { mode: source.authModeOverride } : undefined,
        tailscaleMode: config.gateway?.tailscale?.mode,
      });
      // Proxy session generations omit the local password fallback's credential generation.
      if (
        ((source.authMethod === "password" || source.authMethod === "token") &&
          !isGatewayAuthGrantCurrent(source, config)) ||
        (source.authMethod === "trusted-proxy" &&
          (auth.mode !== "trusted-proxy" ||
            !auth.trustedProxy ||
            !source.verifiedIdentity ||
            (auth.trustedProxy.allowUsers?.length &&
              !auth.trustedProxy.allowUsers.includes(source.verifiedIdentity)))) ||
        (source.authMethod === "tailscale" &&
          (!auth.allowTailscale || auth.mode === "trusted-proxy" || auth.mode === "none")) ||
        (source.browserOrigin && !checkGatewayWsBrowserOrigin(source.browserOrigin, config).ok)
      ) {
        throw new GatewayOperatorRecoveryAuthorizationError(
          "The saved requester cannot access this Gateway; submit a new authenticated request.",
        );
      }
    }
    if (snapshot.sourceIngress === "principal" && !principal) {
      ingress?.assertCurrent();
      if (profile.profileId !== GATEWAY_OWNER_PROFILE_ID) {
        const resolver = context.resolveGatewayContext
          ? getCanonicalGatewayContextResolver(context.resolveGatewayContext)
          : undefined;
        const host = resolver ? getGatewayControlUiIngressHost(resolver) : undefined;
        const eligibilityError = gatewayPersonPrincipalAuthError(
          host?.getResolvedAuth() ?? resolveGatewayAuthForConfig({ config }),
          config,
          profile.emails,
          operatorRoleSubject(profile),
        );
        if (eligibilityError) {
          throw new GatewayOperatorRecoveryAuthorizationError(eligibilityError);
        }
      }
    }
    const profileRevision = identity.readCurrentRevision(snapshot.aliasBindingIds);
    const access =
      principal?.kind === "owner"
        ? null
        : resolvePreparedGatewayOperatorAccessAuthority(
            {
              ...profile,
              role: profile.assignedRole,
              isCurrent: () =>
                identity.readCurrentRevision(snapshot.aliasBindingIds) === profileRevision,
            },
            config,
            { openclawIdPrincipal: principal },
          );
    const live = captureChannelOperatorRunAuthority({
      ...profile,
      scopes,
      openclawIdPrincipal: principal,
      gatewayAccessGrant: access?.gatewayAccessGrant ?? null,
      getRuntimeConfig: () => config,
      assertCurrent,
      signal: claim.signal,
    });
    const role = live.readCurrentRoleFacts?.().policy;
    if (role) {
      scopes = intersectOperatorScopes(scopes, role.scopes);
    }
    if (scopes.length === 0) {
      throw new GatewayOperatorRecoveryAuthorizationError(
        "Gateway access is not active for this requester; ask an administrator to restore access.",
      );
    }
    const originalModels = snapshot.modelPolicy
      ? restoreOperatorModelPolicySnapshot(snapshot.modelPolicy)
      : undefined;
    const authority = createAdmittedRunOperatorAuthority({
      ...live,
      scopes,
      recoverySnapshot: snapshot,
      assertCurrent,
      signal: claim.signal,
      retain: () => {
        assertCurrent();
        references += 1;
        return releaseHold();
      },
      modelPolicy: intersectOperatorRunModelPolicy(originalModels, live.modelPolicy),
    });
    const row = readResidentUserProfileRevision(snapshot.profileId, profileCatalogPath({}));
    if (!row) {
      throw new GatewayOperatorAccessUnavailableError();
    }
    const { id, ...display } = projectUserProfileDisplay(row);
    return {
      authority,
      authenticatedUserProfile: { profileId: id, ...display, updatedAt: row.updated_at },
      automationAdmin:
        hasAutomationAdminDelegation(snapshot) && operatorScopeSatisfied("operator.admin", scopes),
      controlUiAdmin: snapshot.controlUiAdmin && operatorScopeSatisfied("operator.admin", scopes),
      release,
    };
  } catch (error) {
    release();
    if (error instanceof UserProfileMutationUnsettledError) {
      throw new GatewayOperatorAccessUnavailableError();
    }
    if (error instanceof GatewayOperatorAccessDeniedError) {
      if (error.accessCause === "policy-unavailable") {
        throw new GatewayOperatorAccessUnavailableError();
      }
      throw new GatewayOperatorRecoveryAuthorizationError(error.message, { cause: error });
    }
    throw error;
  } finally {
    ingress?.release();
    preparedIdentity?.release();
  }
}

/** Restore owner-held continuation evidence through the shared authentication owner. */
export async function restoreGatewayOperatorSource(params: {
  snapshot: OperatorRunRecoverySnapshot;
  /** The chat this authority serves, by key: edits, resets and compaction keep it; deletion ends it. */
  target?: { agentId: string; sessionKey: string };
  context: GatewayRequestContext;
  assertCurrent: () => void;
  prepareCurrent?: () => Promise<void>;
}): Promise<RestoredGatewayOperatorAuthority> {
  const target = params.target ? { ...params.target } : undefined;
  return restoreGatewayOperatorSnapshot({
    ...params,
    subscribeToClaim: target
      ? (revoke) =>
          onSessionIdentityMutation((mutation) => {
            if (
              mutation.kind === "delete" &&
              mutation.agentId === target.agentId &&
              mutation.previous.sessionKeys.includes(target.sessionKey)
            ) {
              revoke();
            }
          })
      : undefined,
  });
}

/** A queued native launch reuses its original authenticated source, never profile attribution. */
export async function restoreGatewayQueuedOperatorRecovery(params: {
  source: unknown;
  context: GatewayRequestContext;
  assertCurrent: () => void;
}): Promise<
  Pick<
    RestoredGatewayOperatorAuthority,
    "authority" | "controlUiAdmin" | "automationAdmin" | "release"
  > & {
    /** Only Gateway recovery reauthenticates a Control UI profile. */
    authenticatedUserProfile?: GatewayAuthenticatedUserProfile;
  }
> {
  params.assertCurrent();
  const source = decodeQueuedOperatorRecoverySource(params.source);
  if (source.kind === "unavailable") {
    throw new Error("Queued operator authority cannot be recovered; submit a new request.");
  }
  if (source.kind === "gateway") {
    return restoreGatewayOperatorSnapshot({
      context: params.context,
      assertCurrent: params.assertCurrent,
      snapshot: source.snapshot,
    });
  }
  const snapshot = source.snapshot;
  const getConfig = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
  const prepared = await prepareChannelOperatorAuthority(getConfig(), snapshot.reference).catch(
    (cause: unknown) => {
      if (cause instanceof UserProfileMutationUnsettledError) {
        throw new GatewayOperatorAccessUnavailableError();
      }
      if (cause instanceof GatewayOperatorAccessDeniedError) {
        throw new GatewayOperatorRecoveryAuthorizationError(undefined, { cause });
      }
      throw cause;
    },
  );
  const config = getConfig();
  params.assertCurrent();
  const profile = prepared?.operatorProfile;
  if (!profile || profile.profileId !== snapshot.profileId || !prepared?.isCurrent(config)) {
    throw new GatewayOperatorRecoveryAuthorizationError(
      "Queued channel operator authority changed; submit a new request.",
    );
  }
  let references = 1;
  const assertCurrent = () => {
    if (references === 0) {
      throw new Error("Queued channel operator authority is no longer active.");
    }
    params.assertCurrent();
    // The channel reference was admitted above. Revocation applies to the next start.
  };
  const live = captureChannelOperatorRunAuthority({
    ...profile,
    recoveryReference: snapshot.reference,
    scopes: intersectOperatorScopes(snapshot.scopes, profile.scopes),
    getRuntimeConfig: () => config,
    assertCurrent,
  });
  const releaseHold = () => {
    let released = false;
    return () => {
      if (!released) {
        released = true;
        references -= 1;
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
      assertCurrent,
      channelRecoverySource: { reference: snapshot.reference, modelPolicy: originalModels },
      retain: () => {
        if (references === 0) {
          throw new Error("Queued channel operator authority is no longer active.");
        }
        references += 1;
        return releaseHold();
      },
      modelPolicy: intersectOperatorRunModelPolicy(originalModels, live.modelPolicy),
    });
    authority.assertCurrent();
    return { authority, controlUiAdmin: false, automationAdmin: false, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Accepted work runs on its origin's saved facts and current policy, not its accepting request. */
export async function captureGatewayOperatorContinuation(
  input: GatewayOperatorRunAdmissionInput,
): Promise<PreparedGatewayOperatorRunAuthority | undefined> {
  const inherited = input.client?.internal?.operatorRunAuthority;
  if (!inherited) {
    return prepareGatewayOperatorRunAuthority(input);
  }
  const facts = captureQueuedOperatorRecoverySource(inherited);
  if (!facts || facts.kind === "unavailable") {
    throw new GatewayOperatorRecoveryAuthorizationError(
      "This requester cannot be recovered for another turn; submit a new authenticated request.",
    );
  }
  const context = input.context.resolveGatewayContext?.();
  if (!context) {
    throw new GatewayOperatorAccessUnavailableError();
  }
  const restored = await restoreGatewayQueuedOperatorRecovery({
    source: facts,
    context,
    assertCurrent: () => {},
  });
  const authority = createAdmittedRunOperatorAuthority({
    ...restored.authority,
    // One origin keeps one comparable source identity, as completion batches require.
    source: inherited.source,
    scopes: intersectOperatorScopes(restored.authority.scopes, input.client?.connect.scopes ?? []),
  });
  return { authority, release: restored.release };
}
