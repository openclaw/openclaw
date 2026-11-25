import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { captureOperatorModelPolicySnapshot } from "../agents/operator-model-policy.js";
import type { PreparedOperatorModelPolicy } from "../agents/operator-model-policy.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../infra/device-pairing-store-readonly.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import type { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { isBrowserOperatorUiClient } from "../utils/message-channel.js";
import { captureGatewayAuthPolicy, resolveGatewayAuthPolicyGrant } from "./auth-policy.js";
import {
  decodeQueuedOperatorRecoverySource,
  normalizeGatewayOperatorRecoverySnapshot,
  type OperatorRecoveryUnavailableReason,
  type OperatorRunRecoverySnapshot,
  type QueuedOperatorRecoverySource,
} from "./operator-run-recovery-source.codec.js";
import { resolveGatewayUiAdminSource } from "./operator-scopes.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

/** Durable evidence when serializable; same-process starts also pass their original live facts. */
export function captureQueuedOperatorRecoverySource(
  authority: AdmittedRunOperatorAuthority | undefined,
): QueuedOperatorRecoverySource | undefined {
  // A configured channel owner records no source: each start re-admits it from config.
  if (!authority || authority.channelOwner) {
    return undefined;
  }
  assertAdmittedRunOperatorAuthority(authority);
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
export async function captureGatewayOperatorRecoverySnapshot(params: {
  client: GatewayClient;
  authority: Pick<
    AdmittedRunOperatorAuthority,
    "profileId" | "scopes" | "gatewayAccessGrant" | "openclawIdPrincipal"
  >;
  modelPolicy: PreparedOperatorModelPolicy | undefined;
  identity: Awaited<ReturnType<typeof prepareUserProfileIdentity>>;
  config: OpenClawConfig;
}): Promise<
  {
    device?: AdmittedRunOperatorAuthority["device"];
    authPolicy?: AdmittedRunOperatorAuthority["authPolicy"];
    sharedGeneration?: string;
  } & (
    | { snapshot: OperatorRunRecoverySnapshot; unavailableReason?: undefined }
    | { snapshot?: undefined; unavailableReason: OperatorRecoveryUnavailableReason }
  )
> {
  const { client, authority, identity } = params;
  const ocid = authority.openclawIdPrincipal?.authority !== undefined;
  const sourcePolicy =
    client.authPolicy ??
    (ocid
      ? captureGatewayAuthPolicy(params.config, { role: "operator", authMethod: "trusted-proxy" })
      : undefined);
  const authPolicy = sourcePolicy && {
    role: sourcePolicy.role,
    authMethod: sourcePolicy.authMethod,
    authModeOverride: sourcePolicy.authModeOverride,
    verifiedIdentity: sourcePolicy.verifiedIdentity,
    delegation: sourcePolicy.delegation,
    grantGeneration: sourcePolicy.grantGeneration,
    fallbackCredentialGeneration:
      sourcePolicy.authMethod === "password"
        ? resolveGatewayAuthPolicyGrant(params.config, sourcePolicy).fallbackCredentialGeneration
        : undefined,
  };
  const sharedGeneration =
    !client.internal?.remoteIngressPrincipal && client.usesSharedGatewayAuth
      ? client.sharedGatewaySessionGeneration
      : undefined;
  const sourceDevice = client.connect.device;
  const tokenDevice = client.internal?.operatorDeviceTokenIdentity;
  let device: AdmittedRunOperatorAuthority["device"];
  if (sourceDevice && tokenDevice) {
    // The next start checks the accepted token generation, so a rotated token is refused.
    device = tokenDevice;
  }
  const tokenlessIdentity =
    !ocid &&
    tokenDevice == null &&
    (sourcePolicy?.authMethod === "trusted-proxy" || sourcePolicy?.authMethod === "tailscale");
  if (sourceDevice && tokenlessIdentity) {
    try {
      const paired = await loadPairedDevicePairingStoreRecordReadOnly(sourceDevice.id);
      if (paired) {
        device = { deviceId: sourceDevice.id, key: sha256Hex(paired.publicKey) };
      }
    } catch {
      // Capture cannot invent a pairing dependency when its row is unavailable.
      return { authPolicy, sharedGeneration, unavailableReason: "device-no-token" };
    }
  }
  const remote = client.internal?.remoteIngressPrincipal;
  if (remote) {
    if (!remote.recoverySource) {
      return {
        device,
        authPolicy,
        sharedGeneration,
        unavailableReason: "remote-ingress-no-source",
      };
    }
    const modelPolicy = captureOperatorModelPolicySnapshot(params.modelPolicy);
    if (params.modelPolicy && !modelPolicy) {
      return { device, authPolicy, sharedGeneration, unavailableReason: "model-policy" };
    }
    const profile = identity.readCurrentProfile();
    const snapshot = normalizeGatewayOperatorRecoverySnapshot({
      profileId: authority.profileId,
      openclawIdPrincipal: authority.openclawIdPrincipal,
      scopes: [...authority.scopes],
      assignedRole: profile.assignedRole,
      githubLogin: profile.githubLogin ?? null,
      modelPolicy,
      grant: authority.gatewayAccessGrant,
      aliasBindingIds: identity.emailBindingIds,
      sourceIngress: "principal",
      ingress: remote.recoverySource,
      controlUiAdmin: false,
      localOperator: false,
    });
    return snapshot
      ? { device, authPolicy, sharedGeneration, snapshot }
      : { device, authPolicy, sharedGeneration, unavailableReason: "decode-failed" };
  }
  if (!ocid && (!client.internal?.authenticatedOperator || client.internal.syntheticClient)) {
    return { device, authPolicy, sharedGeneration, unavailableReason: "unauthenticated" };
  }
  if (!authPolicy?.authMethod) {
    return { device, authPolicy, sharedGeneration, unavailableReason: "no-auth-method" };
  }
  if (authority.gatewayAccessGrant === undefined) {
    return { device, authPolicy, sharedGeneration, unavailableReason: "no-grant" };
  }
  if (sourceDevice && tokenDevice === undefined && !tokenlessIdentity) {
    return { device, authPolicy, sharedGeneration, unavailableReason: "device-no-token" };
  }
  if (client.usesSharedGatewayAuth && sharedGeneration === undefined) {
    return { device, authPolicy, sharedGeneration, unavailableReason: "shared-auth-no-generation" };
  }
  const modelPolicy = captureOperatorModelPolicySnapshot(params.modelPolicy);
  if (params.modelPolicy && !modelPolicy) {
    return { device, authPolicy, sharedGeneration, unavailableReason: "model-policy" };
  }
  const profile = identity.readCurrentProfile();
  const source = {
    profileId: authority.profileId,
    openclawIdPrincipal: authority.openclawIdPrincipal,
    scopes: [...authority.scopes],
    assignedRole: profile.assignedRole,
    githubLogin: profile.githubLogin ?? null,
    modelPolicy,
    grant: authority.gatewayAccessGrant,
    aliasBindingIds: identity.emailBindingIds,
    // Accepted work follows its grant, not unrelated handshake policy changes.
    sharedGeneration,
    device: tokenDevice ?? (tokenlessIdentity ? device : undefined),
    authPolicy: {
      ...sourcePolicy,
      generation: "",
      fallbackCredentialGeneration: authPolicy.fallbackCredentialGeneration,
    },
    automationAdmin: resolveGatewayUiAdminSource(client) !== undefined,
    controlUiAdmin: client.internal?.controlUiAdmin === true,
    localOperator: client.internal?.isLocalClient === true,
    sourceIngress: isBrowserOperatorUiClient(client.connect.client) ? "control-ui" : "internal",
  };
  const snapshot = normalizeGatewayOperatorRecoverySnapshot(source);
  return snapshot
    ? { device, authPolicy, sharedGeneration, snapshot }
    : { device, authPolicy, sharedGeneration, unavailableReason: "decode-failed" };
}
