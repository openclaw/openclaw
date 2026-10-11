import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  captureOperatorModelPolicySnapshot,
  type PreparedOperatorModelPolicy,
} from "../agents/operator-model-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import type { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { isBrowserOperatorUiClient } from "../utils/message-channel.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
import {
  snapshotSchema,
  sourceSchema,
  type OperatorRunRecoverySnapshot,
  type RestartRecoveryOperatorSource,
} from "./operator-run-recovery-source.schema.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

const MAX_RECOVERY_SOURCE_BYTES = 65_536;
export type {
  OperatorRunRecoverySnapshot,
  RestartRecoveryOperatorSource,
} from "./operator-run-recovery-source.schema.js";

export function decodeGatewayOperatorRecoverySource(value: unknown): RestartRecoveryOperatorSource {
  const json = JSON.stringify(value);
  if (!json || Buffer.byteLength(json, "utf8") > MAX_RECOVERY_SOURCE_BYTES) {
    throw new Error("Restart recovery operator source exceeds its storage bound.");
  }
  const parsed = sourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Restart recovery operator source is invalid; start a new user turn.");
  }
  return freezeJsonSnapshot(parsed.data);
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
  const parsed = snapshotSchema.safeParse(JSON.parse(json));
  return parsed.success ? freezeJsonSnapshot(parsed.data) : undefined;
}
