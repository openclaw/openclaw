import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import {
  captureOperatorModelPolicySnapshot,
  type PreparedOperatorModelPolicy,
} from "../agents/operator-model-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import type { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { isBrowserOperatorUiClient } from "../utils/message-channel.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
import {
  decodeQueuedOperatorRecoverySource,
  MAX_RECOVERY_SOURCE_BYTES,
  operatorRunRecoverySnapshotSchema,
  type OperatorRunRecoverySnapshot,
  type QueuedOperatorRecoverySource,
} from "./operator-run-recovery-source.codec.js";
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
      return { kind: "unavailable" };
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
    return { kind: "unavailable" };
  }
  try {
    return decodeQueuedOperatorRecoverySource(captured);
  } catch {
    // Recovery limits must not reject work under its current live authority.
    return { kind: "unavailable" };
  }
}

/** Capture only handshake-attested input; internal callers cannot manufacture a durable source. */
export function captureGatewayOperatorRecoverySnapshot(params: {
  client: GatewayClient;
  authority: Pick<
    AdmittedRunOperatorAuthority,
    "profileId" | "scopes" | "gatewayAccessGrant" | "assertCurrent"
  >;
  modelPolicy: PreparedOperatorModelPolicy | undefined;
  identity: Awaited<ReturnType<typeof prepareUserProfileIdentity>>;
  config: OpenClawConfig;
}): OperatorRunRecoverySnapshot | undefined {
  const { client, authority, identity } = params;
  if (
    !client.internal?.authenticatedOperator ||
    client.internal.syntheticClient ||
    !client.authPolicy?.authMethod ||
    authority.gatewayAccessGrant === undefined
  ) {
    return undefined;
  }
  authority.assertCurrent();
  const device = client.internal.operatorDeviceTokenIdentity ?? undefined;
  if (client.connect.device && client.internal.operatorDeviceTokenIdentity === undefined) {
    return undefined;
  }
  const sharedGeneration = client.usesSharedGatewayAuth
    ? client.sharedGatewaySessionGeneration
    : undefined;
  if (client.usesSharedGatewayAuth && sharedGeneration === undefined) {
    return undefined;
  }
  const modelPolicy = captureOperatorModelPolicySnapshot(params.modelPolicy);
  if (params.modelPolicy && !modelPolicy) {
    return undefined;
  }
  const profile = identity.readCurrentProfile();
  const source = {
    profileId: authority.profileId,
    scopes: [...authority.scopes],
    assignedRole: profile.assignedRole,
    githubLogin: profile.githubLogin ?? null,
    rolePolicy: sourceRolePolicy(
      resolveOperatorRolePolicyForAssignment(
        profile.profileId,
        profile.assignedRole,
        params.config,
        profile.githubLogin ?? null,
      ),
    ),
    modelPolicy,
    grant: authority.gatewayAccessGrant,
    aliasBindingIds: identity.emailBindingIds,
    // Accepted work follows its grant, not unrelated handshake policy changes.
    authPolicy: { ...client.authPolicy, generation: "" },
    sharedGeneration,
    device,
    controlUiAdmin: client.internal.controlUiAdmin === true,
    localOperator: client.internal.isLocalClient === true,
    sourceIngress: isBrowserOperatorUiClient(client.connect.client) ? "control-ui" : "internal",
  };
  const json = JSON.stringify(source);
  if (Buffer.byteLength(json, "utf8") > MAX_RECOVERY_SOURCE_BYTES) {
    return undefined;
  }
  // Admission must capture the same optional-field shape the durable claim
  // reloads; canonicalization belongs here, not in a permissive comparison.
  const parsed = operatorRunRecoverySnapshotSchema.safeParse(JSON.parse(json));
  return parsed.success ? freezeJsonSnapshot(parsed.data) : undefined;
}
