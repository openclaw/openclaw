import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  assertAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import {
  prepareOperatorModelPolicy,
  restoreOperatorModelPolicySnapshot,
} from "../agents/operator-model-policy.js";
import { isConfiguredCommandOwner } from "../auto-reply/command-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isAbortError } from "../infra/abort-signal.js";
import {
  isPairedDeviceTokenIdentityCurrent,
  listApprovedPairedDeviceRoles,
} from "../infra/device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../infra/device-pairing-store-readonly.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
import {
  GatewayDispatchUnavailableError,
  GatewayOperatorRecoveryAuthorizationError,
} from "../infra/restart-recovery-errors.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getCanonicalGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  intersectOperatorScopes,
  operatorScopeSatisfied,
} from "../shared/operator-scope-compat.js";
import { resolveUserChannelAuthorizationPolicy } from "../state/user-channel-identities.js";
import { prepareUserChannelIdentityAuthority } from "../state/user-channel-identity-operations.js";
import { UserProfileMutationUnsettledError } from "../state/user-profile-events.js";
import { profileCatalogPath } from "../state/user-profile-identity.read.js";
import {
  prepareUserProfileIdentity,
  projectUserProfileDisplay,
  readResidentUserProfileRevision,
} from "../state/user-profile-list.js";
import type {
  PreparedUserProfileIdentity,
  UserChannelIdentity,
} from "../state/user-profiles.types.js";
import { resolveGatewayAuthPolicyGrant } from "./auth-policy.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import { gatewayPersonPrincipalAuthError, type ResolvedGatewayAuth } from "./auth.js";
import { prepareChannelOperatorAuthority } from "./channel-operator-authority.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  readOpenClawIdTunnelPrincipal,
  openclawIdSubjectRolePolicy,
  prepareOpenClawIdTunnelPrincipalLookup,
} from "./openclaw-id/tunnel-principal.js";
import {
  GatewayOperatorAccessDeniedError,
  resolvePreparedGatewayOperatorAccessAuthority,
} from "./operator-access-policy.js";
import { operatorRoleSubject } from "./operator-role-enforcement.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { intersectOperatorRunModelPolicy } from "./operator-run-authority.js";
import {
  hasAutomationAdminDelegation,
  type QueuedOperatorRecoverySource,
  type RestartRecoveryOperatorSource,
} from "./operator-run-recovery-source.codec.js";
import { getGatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { restoreIngressPrincipalRecovery } from "./remote-ingress-principal-recovery.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

type Facts =
  | (Extract<QueuedOperatorRecoverySource, { kind: "gateway" }> & {
      source?: RestartRecoveryOperatorSource;
    })
  | Extract<QueuedOperatorRecoverySource, { kind: "channel" }>
  | { kind: "live"; authority: AdmittedRunOperatorAuthority };
type PreparedOperatorAdmission = {
  config: OpenClawConfig;
  context: GatewayRequestContext;
  identity: PreparedUserProfileIdentity;
  paired: PairedDevice | null | undefined;
  ingress:
    | { assertCurrent: () => void; release: () => void; scopes: readonly string[] }
    | undefined;
  channel:
    | {
        isCurrent: (config: OpenClawConfig) => boolean;
        operatorProfile: {
          profileId: string;
          scopes: readonly string[];
          gatewayAccessGrant: AdmittedRunOperatorAuthority["gatewayAccessGrant"];
        };
      }
    | undefined;
  channelIdentity: UserChannelIdentity | undefined;
  ingressAuth: ResolvedGatewayAuth;
};

function admissionError(error: unknown, facts: Facts): never {
  if (
    error instanceof UserProfileMutationUnsettledError ||
    (error instanceof GatewayDispatchUnavailableError && error.retryable) ||
    (error instanceof GatewayOperatorAccessDeniedError &&
      error.accessCause === "policy-unavailable")
  ) {
    throw new GatewayOperatorAccessUnavailableError();
  }
  if (
    isAbortError(error) &&
    ((facts.kind === "gateway" && facts.snapshot.sourceIngress === "principal") ||
      (facts.kind === "live" && facts.authority.ingress?.signal.aborted))
  ) {
    throw new GatewayOperatorRecoveryAuthorizationError(undefined, { cause: error });
  }
  if (error instanceof GatewayOperatorAccessDeniedError) {
    throw new GatewayOperatorRecoveryAuthorizationError(error.message, { cause: error });
  }
  throw error;
}

/** Load the owners needed for one start; no authority escapes this preparation. */
export async function prepareOperatorAdmission(
  facts: Facts,
  context: GatewayRequestContext,
): Promise<PreparedOperatorAdmission> {
  let identity: PreparedUserProfileIdentity | undefined;
  let ingress: PreparedOperatorAdmission["ingress"];
  try {
    const snapshot = facts.kind === "live" ? facts.authority : facts.snapshot;
    const readConfig = context.getCommittedRuntimeConfig ?? context.getRuntimeConfig;
    const native =
      facts.kind === "channel"
        ? await prepareUserChannelIdentityAuthority({
            authorizationId: facts.snapshot.reference.id,
            policy: resolveUserChannelAuthorizationPolicy(readConfig().gateway),
          })
        : undefined;
    const channelIdentity = native?.linked.identity;
    const channel =
      native && channelIdentity
        ? await prepareChannelOperatorAuthority(readConfig(), {
            identity: channelIdentity,
            prepared: native,
          })
        : undefined;
    identity = await prepareUserProfileIdentity(snapshot.profileId);
    const gateway = facts.kind === "gateway" ? facts.snapshot : undefined;
    const principal =
      facts.kind === "live" ? facts.authority.openclawIdPrincipal : gateway?.openclawIdPrincipal;
    if (principal) {
      await prepareOpenClawIdTunnelPrincipalLookup();
    }
    const device = gateway?.device ?? (facts.kind === "live" ? facts.authority.device : undefined);
    const paired = device
      ? await loadPairedDevicePairingStoreRecordReadOnly(device.deviceId).catch(() => {
          throw new GatewayOperatorAccessUnavailableError();
        })
      : undefined;
    if (gateway?.sourceIngress === "principal") {
      ingress = await restoreIngressPrincipalRecovery(
        context,
        gateway.ingress,
        gateway.profileId,
        gateway.scopes,
      );
    }
    const config = readConfig();
    const resolver = context.resolveGatewayContext
      ? getCanonicalGatewayContextResolver(context.resolveGatewayContext)
      : undefined;
    const ingressAuth =
      (resolver && getGatewayControlUiIngressHost(resolver)?.getResolvedAuth()) ||
      resolveGatewayAuthForConfig({ config });
    return { config, context, identity, ingress, paired, channel, channelIdentity, ingressAuth };
  } catch (error) {
    ingress?.release();
    identity?.release();
    return admissionError(error, facts);
  }
}

/** Decide once from prepared owners and committed config; the run keeps only frozen facts. */
export function decideOperatorAdmission(facts: Facts, prepared: PreparedOperatorAdmission) {
  const { config, identity, ingress, paired, channel, channelIdentity, context } = prepared;
  const live = facts.kind === "live" ? facts.authority : undefined;
  const snapshot = facts.kind === "live" ? facts.authority : facts.snapshot;
  const gateway = facts.kind === "gateway" ? facts.snapshot : undefined;
  const principal = live?.openclawIdPrincipal ?? gateway?.openclawIdPrincipal;
  const device = gateway?.device ?? live?.device;
  try {
    if (live) {
      assertAdmittedRunOperatorAuthority(live);
      live.assertCurrent();
    }
    if (principal) {
      if (config.gateway?.openclawId?.enabled === false) {
        throw new GatewayOperatorRecoveryAuthorizationError();
      }
      if (readOpenClawIdTunnelPrincipal(principal.peerKey) === null) {
        if (config.gateway?.openclawId?.enabled) {
          throw new GatewayOperatorAccessUnavailableError();
        }
        throw new GatewayOperatorRecoveryAuthorizationError();
      }
      if (!isOpenClawIdTunnelPrincipalCurrent(principal)) {
        throw new GatewayOperatorRecoveryAuthorizationError();
      }
    }
    const profile = identity.readCurrentFacts(gateway?.aliasBindingIds).profile;
    const refuse = () => {
      throw new GatewayOperatorRecoveryAuthorizationError();
    };
    if (profile.profileId !== snapshot.profileId) {
      refuse();
    }
    let scopes = snapshot.scopes;
    let grant = channel?.operatorProfile.gatewayAccessGrant;
    if (facts.kind === "channel") {
      if (
        !channel ||
        channel.operatorProfile.profileId !== snapshot.profileId ||
        !channel.isCurrent(config)
      ) {
        throw new GatewayOperatorRecoveryAuthorizationError();
      }
      scopes = intersectOperatorScopes(scopes, channel.operatorProfile.scopes);
    }
    const source = gateway?.authPolicy;
    // Browser origin is checked at connect; saved work follows its person's access,
    // not the submitting browser (owner decision, 2026-11-20).
    const policy =
      !principal && (source || live?.verifiedIdentity)
        ? resolveGatewayAuthPolicyGrant(
            config,
            source
              ? { ...source, browserOrigin: undefined }
              : { role: "operator", verifiedIdentity: live?.verifiedIdentity },
          )
        : undefined;
    if (gateway) {
      // Proxy policy generations do not describe either ambient identity or local fallback secrets.
      const sharedGeneration =
        !principal &&
        (source?.authMethod === "trusted-proxy" ||
          (source?.authMethod === "password" &&
            (source.fallbackCredentialGeneration !== undefined ||
              policy?.methodEnabled !== undefined)))
          ? undefined
          : gateway.sharedGeneration;
      if (sharedGeneration !== undefined) {
        if (!context.sharedGatewaySessionGenerationState) {
          throw new GatewayOperatorAccessUnavailableError();
        }
        if (context.sharedGatewaySessionGenerationState.requiredGeneration !== sharedGeneration) {
          refuse();
        }
      }
      if (policy && (policy.methodEnabled === false || policy.proxyUserAllowed === false)) {
        refuse();
      }
      if (source?.authMethod === "password" && !principal) {
        if (
          source.fallbackCredentialGeneration !== undefined
            ? source.fallbackCredentialGeneration !== policy?.fallbackCredentialGeneration
            : policy?.fallbackCredentialGeneration !== undefined &&
              source.grantGeneration !==
                stableStringify(resolveGatewayAuthPolicyGrant(config, source))
        ) {
          refuse();
        }
      }
    }
    if (device) {
      const tokenCurrent = isPairedDeviceTokenIdentityCurrent(
        paired ?? null,
        "operator",
        device,
        [],
      );
      const tokenlessIdentityCurrent =
        (live !== undefined ||
          (!principal &&
            (source?.authMethod === "trusted-proxy" || source?.authMethod === "tailscale"))) &&
        paired &&
        paired.deviceId === device.deviceId &&
        device.key === sha256Hex(paired.publicKey) &&
        listApprovedPairedDeviceRoles(paired).includes("operator") &&
        !paired.tokens?.operator?.revokedAtMs;
      if (!tokenCurrent && !tokenlessIdentityCurrent) {
        refuse();
      }
      scopes = intersectOperatorScopes(scopes, [
        ...(tokenCurrent
          ? (paired?.tokens?.operator?.scopes ?? [])
          : (paired?.approvedScopes ?? paired?.scopes ?? [])),
        ...(policy?.grant ?? []),
      ]);
    } else if (source?.authMethod === "tailscale") {
      // Older rows omitted tokenless device facts. An unchanged grant preserves their
      // hidden device scopes; changed grants can only narrow until these rows age out.
      if (
        source.grantGeneration !== stableStringify(resolveGatewayAuthPolicyGrant(config, source))
      ) {
        scopes = intersectOperatorScopes(scopes, policy?.grant ?? []);
      }
    } else if (source?.authMethod === "trusted-proxy" && !principal) {
      scopes = intersectOperatorScopes(scopes, policy?.grant ?? []);
    }
    if (gateway?.sourceIngress === "principal") {
      ingress?.assertCurrent();
      scopes = intersectOperatorScopes(scopes, ingress?.scopes ?? []);
    }
    if (live?.ingress) {
      const bound = live.ingress;
      const profileId =
        bound.principal.kind === "owner" ? GATEWAY_OWNER_PROFILE_ID : bound.principal.profileId;
      if (bound.signal.aborted || profileId !== profile.profileId) {
        throw new GatewayOperatorRecoveryAuthorizationError();
      }
      scopes = intersectOperatorScopes(scopes, bound.scopeCeiling);
    }
    if (
      (gateway?.sourceIngress === "principal" || live?.ingress) &&
      !principal &&
      profile.profileId !== GATEWAY_OWNER_PROFILE_ID
    ) {
      const error = gatewayPersonPrincipalAuthError(
        prepared.ingressAuth,
        config,
        profile.emails,
        operatorRoleSubject(profile),
      );
      if (error) {
        throw new GatewayOperatorRecoveryAuthorizationError(error);
      }
    }
    if (gateway || live) {
      const access =
        principal?.kind === "owner"
          ? null
          : resolvePreparedGatewayOperatorAccessAuthority(
              { ...profile, role: profile.assignedRole, isCurrent: () => true },
              config,
              { openclawIdPrincipal: principal },
            );
      access?.assertCurrent();
      grant = access?.gatewayAccessGrant ?? null;
    }
    const role = structuredClone(
      openclawIdSubjectRolePolicy(principal, () =>
        resolveOperatorRolePolicyForAssignment(
          profile.profileId,
          profile.assignedRole,
          config,
          profile.githubLogin ?? null,
          operatorRoleSubject(profile),
        ),
      ),
    );
    if (role) {
      scopes = intersectOperatorScopes(scopes, role.scopes);
    }
    if (scopes.length === 0) {
      throw new GatewayOperatorRecoveryAuthorizationError(
        "Gateway access is not active for this requester; ask an administrator to restore access.",
      );
    }
    const originalModels =
      live?.modelPolicy ??
      (facts.kind !== "live" && facts.snapshot.modelPolicy
        ? restoreOperatorModelPolicySnapshot(facts.snapshot.modelPolicy)
        : undefined);
    const modelPolicy = intersectOperatorRunModelPolicy(
      originalModels,
      prepareOperatorModelPolicy({
        cfg: config,
        policy: role?.modelPolicy,
        manifestPlugins: getProcessGatewayPluginMetadataSnapshot() ?? [],
      }),
    );
    const requesterOwner =
      facts.kind === "channel"
        ? channelIdentity !== undefined &&
          (isConfiguredCommandOwner(config, {
            channel: channelIdentity.channelId,
            accountId: channelIdentity.accountId,
            senderId: channelIdentity.senderId,
          }) ||
            operatorScopeSatisfied("operator.admin", scopes))
        : facts.kind === "gateway" && facts.source && facts.source.kind !== "gateway"
          ? principal?.kind !== "member"
          : operatorScopeSatisfied("operator.admin", scopes);
    const authority = createAdmittedRunOperatorAuthority({
      profileId: profile.profileId,
      openclawIdPrincipal: principal,
      device,
      verifiedIdentity: live?.verifiedIdentity ?? source?.verifiedIdentity,
      ingress: live?.ingress,
      scopes,
      gatewayAccessGrant: grant,
      recoverySnapshot: gateway ?? live?.recoverySnapshot,
      recoverySnapshotUnavailableReason: live?.recoverySnapshotUnavailableReason,
      source: live?.source,
      channelRecoverySource:
        facts.kind === "channel"
          ? { reference: facts.snapshot.reference, modelPolicy: originalModels }
          : undefined,
      requesterOwner,
      modelPolicy,
      rolePolicy: role
        ? {
            sessionAccessCap: role.sessions.others,
            sandboxRequired: role.sandbox === "required",
            agents: role.agents,
            accessPrograms: role.accessPrograms,
          }
        : undefined,
      readCurrentRoleFacts: () => ({
        assignedRole: profile.assignedRole,
        githubLogin: profile.githubLogin ?? null,
        openclawIdAccountIds: profile.openclawIdAccountIds,
        policy: role,
      }),
      assertCurrent: () => {},
    });
    const row = readResidentUserProfileRevision(profile.profileId, profileCatalogPath({}));
    if (!row) {
      throw new GatewayOperatorAccessUnavailableError();
    }
    const { id, ...display } = projectUserProfileDisplay(row);
    return {
      authority,
      authenticatedUserProfile: { profileId: id, ...display, updatedAt: row.updated_at },
      automationAdmin: Boolean(
        gateway &&
        hasAutomationAdminDelegation(gateway) &&
        operatorScopeSatisfied("operator.admin", scopes),
      ),
      controlUiAdmin: Boolean(
        gateway?.controlUiAdmin && operatorScopeSatisfied("operator.admin", scopes),
      ),
      release: identity.release,
    };
  } catch (error) {
    identity.release();
    return admissionError(error, facts);
  } finally {
    ingress?.release();
  }
}
