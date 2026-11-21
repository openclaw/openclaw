import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { captureOperatorModelPolicySnapshot } from "../agents/operator-model-policy.js";
import type { PreparedOperatorModelPolicy } from "../agents/operator-model-policy.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import type { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { isBrowserOperatorUiClient } from "../utils/message-channel.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { openclawIdSubjectRolePolicy } from "./openclaw-id/tunnel-principal.js";
import { operatorRoleSubject } from "./operator-role-enforcement.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
import {
  decodeQueuedOperatorRecoverySource,
  normalizeGatewayOperatorRecoverySnapshot,
  type OperatorRecoveryUnavailableReason,
  type OperatorRunRecoverySnapshot,
  type QueuedOperatorRecoverySource,
} from "./operator-run-recovery-source.codec.js";
import { resolveGatewayUiAdminSource } from "./operator-scopes.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

/** An unrecoverable source still runs in memory under its retained live authority. */
export function captureQueuedOperatorRecoverySource(
  authority: AdmittedRunOperatorAuthority | undefined,
): QueuedOperatorRecoverySource | undefined {
  if (!authority) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
  authority.assertCurrent();
  let captured: QueuedOperatorRecoverySource;
  if (authority.recoverySnapshot) {
    const snapshot = authority.recoverySnapshot;
    captured = {
      kind: "gateway",
      snapshot: { ...snapshot, scopes: intersectOperatorScopes(snapshot.scopes, authority.scopes) },
    };
  } else if (authority.channelRecoverySource) {
    const source = authority.channelRecoverySource;
    const modelPolicy = captureOperatorModelPolicySnapshot(source.modelPolicy);
    if (source.modelPolicy && !modelPolicy) {
      return { kind: "unavailable", reason: "channel-model-policy" };
    }
    captured = {
      kind: "channel",
      snapshot: {
        reference: source.reference,
        profileId: authority.profileId,
        scopes: [...authority.scopes],
        modelPolicy,
      },
    };
  } else {
    return {
      kind: "unavailable",
      reason: authority.recoverySnapshotUnavailableReason ?? "no-source",
    };
  }
  try {
    return decodeQueuedOperatorRecoverySource(captured);
  } catch {
    // Recovery limits must not reject work under its current live authority.
    return { kind: "unavailable", reason: "decode-failed" };
  }
}

/** Capture only handshake-attested input; internal callers cannot manufacture a durable source. */
export function captureGatewayOperatorRecoverySnapshot(params: {
  client: GatewayClient;
  authority: Pick<
    AdmittedRunOperatorAuthority,
    "profileId" | "scopes" | "gatewayAccessGrant" | "assertCurrent" | "openclawIdPrincipal"
  >;
  modelPolicy: PreparedOperatorModelPolicy | undefined;
  identity: Awaited<ReturnType<typeof prepareUserProfileIdentity>>;
  config: OpenClawConfig;
}):
  | { snapshot: OperatorRunRecoverySnapshot; unavailableReason?: undefined }
  | { snapshot?: undefined; unavailableReason: OperatorRecoveryUnavailableReason } {
  const { client, authority, identity } = params;
  const remote = client.internal?.remoteIngressPrincipal;
  if (remote) {
    if (!remote.recoverySource) {
      return { unavailableReason: "remote-ingress-no-source" };
    }
    remote.assertCurrent();
    authority.assertCurrent();
    const modelPolicy = captureOperatorModelPolicySnapshot(params.modelPolicy);
    if (params.modelPolicy && !modelPolicy) {
      return { unavailableReason: "model-policy" };
    }
    const profile = identity.readCurrentProfile();
    const snapshot = normalizeGatewayOperatorRecoverySnapshot({
      profileId: authority.profileId,
      openclawIdPrincipal: authority.openclawIdPrincipal,
      scopes: [...authority.scopes],
      assignedRole: profile.assignedRole,
      githubLogin: profile.githubLogin ?? null,
      rolePolicy: sourceRolePolicy(
        openclawIdSubjectRolePolicy(authority.openclawIdPrincipal, () =>
          resolveOperatorRolePolicyForAssignment(
            profile.profileId,
            profile.assignedRole,
            params.config,
            profile.githubLogin ?? null,
            operatorRoleSubject(profile),
          ),
        ),
      ),
      modelPolicy,
      grant: authority.gatewayAccessGrant,
      aliasBindingIds: identity.emailBindingIds,
      sourceIngress: "principal",
      ingress: remote.recoverySource,
      controlUiAdmin: false,
      localOperator: false,
    });
    return snapshot ? { snapshot } : { unavailableReason: "decode-failed" };
  }
  const ocid = authority.openclawIdPrincipal?.authority !== undefined;
  const authPolicy =
    client.authPolicy ??
    (ocid
      ? captureGatewayAuthPolicy(params.config, { role: "operator", authMethod: "trusted-proxy" })
      : undefined);
  if (!ocid && (!client.internal?.authenticatedOperator || client.internal.syntheticClient)) {
    return { unavailableReason: "unauthenticated" };
  }
  if (!authPolicy?.authMethod) {
    return { unavailableReason: "no-auth-method" };
  }
  if (authority.gatewayAccessGrant === undefined) {
    return { unavailableReason: "no-grant" };
  }
  authority.assertCurrent();
  const device = client.internal?.operatorDeviceTokenIdentity ?? undefined;
  if (client.connect.device && client.internal?.operatorDeviceTokenIdentity === undefined) {
    return { unavailableReason: "device-no-token" };
  }
  const sharedGeneration = client.usesSharedGatewayAuth
    ? client.sharedGatewaySessionGeneration
    : undefined;
  if (client.usesSharedGatewayAuth && sharedGeneration === undefined) {
    return { unavailableReason: "shared-auth-no-generation" };
  }
  const modelPolicy = captureOperatorModelPolicySnapshot(params.modelPolicy);
  if (params.modelPolicy && !modelPolicy) {
    return { unavailableReason: "model-policy" };
  }
  const profile = identity.readCurrentProfile();
  const source = {
    profileId: authority.profileId,
    openclawIdPrincipal: authority.openclawIdPrincipal,
    scopes: [...authority.scopes],
    assignedRole: profile.assignedRole,
    githubLogin: profile.githubLogin ?? null,
    rolePolicy: sourceRolePolicy(
      openclawIdSubjectRolePolicy(authority.openclawIdPrincipal, () =>
        resolveOperatorRolePolicyForAssignment(
          profile.profileId,
          profile.assignedRole,
          params.config,
          profile.githubLogin ?? null,
          operatorRoleSubject(profile),
        ),
      ),
    ),
    modelPolicy,
    grant: authority.gatewayAccessGrant,
    aliasBindingIds: identity.emailBindingIds,
    // Accepted work follows its grant, not unrelated handshake policy changes.
    authPolicy: { ...authPolicy, generation: "" },
    sharedGeneration,
    device,
    automationAdmin: resolveGatewayUiAdminSource(client) !== undefined,
    controlUiAdmin: client.internal?.controlUiAdmin === true,
    localOperator: client.internal?.isLocalClient === true,
    sourceIngress: isBrowserOperatorUiClient(client.connect.client) ? "control-ui" : "internal",
  };
  const snapshot = normalizeGatewayOperatorRecoverySnapshot(source);
  return snapshot ? { snapshot } : { unavailableReason: "decode-failed" };
}
