import { z } from "zod";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  captureOperatorModelPolicySnapshot,
  type PreparedOperatorModelPolicy,
} from "../agents/operator-model-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayOperatorRoleDefinitionSchema } from "../config/zod-schema.gateway.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import type { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { isBrowserOperatorUiClient } from "../utils/message-channel.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

const MAX_RECOVERY_SOURCE_BYTES = 65_536;
const boundedString = z.string().min(1).max(4096);
const refs = z.strictObject({
  exact: z.array(boundedString).max(4096),
  wildcards: z.array(boundedString).max(256),
});
const snapshotSchema = z.strictObject({
  profileId: boundedString,
  scopes: z.array(boundedString).max(64),
  assignedRole: boundedString.nullable(),
  githubLogin: boundedString.nullable(),
  rolePolicy: GatewayOperatorRoleDefinitionSchema.omit({ modelPolicy: true }).optional(),
  modelPolicy: z
    .strictObject({
      models: z.array(z.strictObject({ provider: boundedString, model: boundedString })).max(4096),
      allowed: refs,
      denied: refs,
    })
    .optional(),
  grant: z.strictObject({ pluginId: boundedString, grantId: boundedString }).nullable(),
  aliasBindingIds: z.array(boundedString).max(256),
  authPolicy: z.strictObject({
    generation: z.literal(""),
    grantGeneration: boundedString,
    role: z.literal("operator"),
    authMethod: z.enum(["token", "password", "device-token", "tailscale", "trusted-proxy"]),
    authModeOverride: z.enum(["none", "token", "password", "trusted-proxy"]).optional(),
    verifiedIdentity: boundedString.optional(),
    browserOrigin: z
      .strictObject({
        requestHost: boundedString.optional(),
        origin: boundedString.optional(),
        isLocalClient: z.boolean().optional(),
      })
      .optional(),
  }),
  sharedGeneration: boundedString.optional(),
  device: z
    .strictObject({ deviceId: boundedString, key: z.string().regex(/^[a-f0-9]{64}$/) })
    .optional(),
  controlUiAdmin: z.boolean(),
  localOperator: z.boolean(),
  sourceIngress: z.enum(["control-ui", "internal"]),
});
const sourceSchema = z.strictObject({
  version: z.literal(1),
  agentId: boundedString,
  sessionKey: boundedString,
  sessionId: boundedString,
  lifecycleRevision: boundedString.optional(),
  sourceRunId: boundedString,
  snapshot: snapshotSchema,
});

/** Original authenticated basis, not an executable grant or a transport credential. */
export type OperatorRunRecoverySnapshot = z.infer<typeof snapshotSchema>;

/** Private input custody; copied attribution or another session cannot authorize recovery. */
export type RestartRecoveryOperatorSource = z.infer<typeof sourceSchema>;

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
